#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <AVFoundation/AVFoundation.h>
#import <VideoToolbox/VideoToolbox.h>
#include <stdatomic.h>
#include <errno.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <signal.h>
#include <unistd.h>

typedef void (*CaptureCallback)(void *, uint32_t, const uint8_t *, size_t, uint32_t, uint32_t, double, const char *);

static BOOL HardwareH264Available(void) {
    VTCompressionSessionRef session = NULL;
    NSDictionary *specification = @{ (__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: @YES };
    OSStatus status = VTCompressionSessionCreate(kCFAllocatorDefault, 1920, 1080, kCMVideoCodecType_H264,
        (__bridge CFDictionaryRef)specification, NULL, NULL, NULL, NULL, &session);
    if (status != noErr || !session) return NO;
    status = VTCompressionSessionPrepareToEncodeFrames(session);
    CFTypeRef hardware = NULL;
    if (status == noErr) status = VTSessionCopyProperty(session, kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder, kCFAllocatorDefault, &hardware);
    BOOL available = status == noErr && hardware && CFEqual(hardware, kCFBooleanTrue);
    if (hardware) CFRelease(hardware);
    VTCompressionSessionInvalidate(session);
    CFRelease(session);
    return available;
}

static void RemoveAbandonedCaptureDirectories(void) {
    NSFileManager *manager = NSFileManager.defaultManager;
    NSURL *temporary = [NSURL fileURLWithPath:NSTemporaryDirectory() isDirectory:YES];
    NSArray<NSURL *> *entries = [manager contentsOfDirectoryAtURL:temporary includingPropertiesForKeys:@[NSURLIsSymbolicLinkKey, NSURLIsDirectoryKey] options:0 error:nil];
    for (NSURL *entry in entries) {
        if (![entry.lastPathComponent hasPrefix:@"lumiverse-capture-"]) continue;
        NSArray<NSString *> *components = [entry.lastPathComponent componentsSeparatedByString:@"-"];
        if (components.count != 4) continue;
        int process = components[2].intValue;
        if (![[NSString stringWithFormat:@"%d", process] isEqualToString:components[2]] || components[3].length != 6) continue;
        NSNumber *symbolicLink = nil;
        NSNumber *directory = nil;
        [entry getResourceValue:&symbolicLink forKey:NSURLIsSymbolicLinkKey error:nil];
        [entry getResourceValue:&directory forKey:NSURLIsDirectoryKey error:nil];
        if (process > 0 && directory.boolValue && !symbolicLink.boolValue && kill(process, 0) == -1 && errno == ESRCH) {
            [manager removeItemAtURL:entry error:nil];
        }
    }
}

uint32_t lumiverse_capture_capabilities(void) {
    @autoreleasepool {
    if (@available(macOS 14.0, *)) {
        static uint32_t flags;
        static dispatch_once_t once;
        dispatch_once(&once, ^{
            RemoveAbandonedCaptureDirectories();
            flags = 1 | (HardwareH264Available() ? 2 : 0);
        });
        return flags;
    }
    return 0;
    }
}

static NSString *DisplayIdentity(CGDirectDisplayID display) {
    CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(display);
    NSString *identity = uuid ? CFBridgingRelease(CFUUIDCreateString(NULL, uuid)) : nil;
    if (uuid) CFRelease(uuid);
    return identity;
}

// Quartz monitor metadata needs no screen-recording permission and creates no stream.
void lumiverse_capture_displays(void (*callback)(const uint8_t *, size_t, void *), void *context) {
    @autoreleasepool {
        CGDirectDisplayID displays[16];
        uint32_t count = 0;
        NSMutableArray *result = [NSMutableArray new];
        if (CGGetActiveDisplayList(16, displays, &count) == kCGErrorSuccess) {
            for (uint32_t index = 0; index < count; index++) {
                CGDirectDisplayID display = displays[index];
                NSString *identity = DisplayIdentity(display);
                if (!identity) continue;
                [result addObject:@{@"identity":identity, @"name":[NSString stringWithFormat:@"Display %u", index + 1],
                    @"width":@(CGDisplayPixelsWide(display)), @"height":@(CGDisplayPixelsHigh(display)),
                    @"primary":@(display == CGMainDisplayID())}];
            }
        }
        NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        callback(json.bytes, json.length, context);
    }
}

API_AVAILABLE(macos(14.0))
@interface LumiverseCapture : NSObject <SCContentSharingPickerObserver, SCStreamOutput, SCStreamDelegate> {
    atomic_bool _completed;
    atomic_bool _cancelled;
    BOOL _finishing;
    BOOL _sourceChosen;
    BOOL _sessionStarted;
    BOOL _loadingSources;
    BOOL _usingPermissionedSources;
    CMTime _firstTime;
    CMTime _lastTime;
    CMSampleBufferRef _lastBuffer;
}
@property NSString *requestID;
@property NSString *consent;
@property NSString *summary;
@property NSString *savedSource;
@property NSString *requestedDisplay;
@property NSString *selectedSource;
@property BOOL canRemember;
@property void (*invalidateApproval)(void *);
@property void (*rememberSource)(void *, const char *);
@property BOOL remembering;
@property BOOL video;
@property BOOL finishRequested;
@property uint64_t seconds;
@property NSUInteger maximumBytes;
@property uint64_t maximumPixels;
@property uint32_t width;
@property uint32_t height;
@property double duration;
@property NSTimeInterval expiresAt;
@property NSTimeInterval recordStartedAt;
@property CaptureCallback callback;
@property void *context;
@property NSStatusItem *captureIndicator;
@property NSMenuItem *captureStatus;
@property NSMenu *sourceMenu;
@property SCShareableContent *permissionedContent;
@property SCShareableContentStyle requestedStyle;
@property NSTimer *timer;
@property SCStream *stream;
@property dispatch_queue_t outputQueue;
@property AVAssetWriter *writer;
@property AVAssetWriterInput *input;
@property AVURLAsset *validationAsset;
@property NSURL *directory;
@property NSURL *outputURL;
@property NSMutableData *imageData;
- (void)start;
- (void)finishOutcome:(uint32_t)outcome;
- (void)captureFilter:(SCContentFilter *)filter;
- (void)captureFailed:(NSError *)error;
- (void)updateStatus:(NSString *)status;
@end

static LumiverseCapture *currentCapture API_AVAILABLE(macos(14.0));
static NSString *NativeSourceSession(void) {
    static NSString *session;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ session = NSUUID.UUID.UUIDString; });
    return session;
}

@implementation LumiverseCapture

- (instancetype)init {
    self = [super init];
    if (self) {
        atomic_init(&_completed, false);
        atomic_init(&_cancelled, false);
        _firstTime = kCMTimeInvalid;
        _lastTime = kCMTimeInvalid;
        self.outputQueue = dispatch_queue_create("chat.lumiverse.capture.frames", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

- (void)dealloc {
    if (_lastBuffer) CFRelease(_lastBuffer);
}

- (void)start {
    NSLog(@"[Lumiverse capture] pid=%d bundle=%@ packaged=%d screen-recording-access=%d", getpid(),
        NSBundle.mainBundle.bundleIdentifier ?: @"unidentified", [NSBundle.mainBundle.bundlePath.pathExtension isEqualToString:@"app"],
        CGPreflightScreenCaptureAccess());
    self.requestedStyle = SCShareableContentStyleDisplay;
    self.captureIndicator = [NSStatusBar.systemStatusBar statusItemWithLength:NSVariableStatusItemLength];
    self.captureIndicator.button.image = [NSImage imageWithSystemSymbolName:self.video ? @"record.circle" : @"camera" accessibilityDescription:@"Lumiverse capture controls"];
    self.captureIndicator.button.toolTip = self.summary;
    NSMenu *menu = [NSMenu new];
    menu.autoenablesItems = NO;
    for (NSString *line in [self.summary componentsSeparatedByString:@"\n"]) {
        NSMenuItem *identity = [[NSMenuItem alloc] initWithTitle:line action:nil keyEquivalent:@""];
        identity.enabled = NO;
        identity.toolTip = self.consent;
        [menu addItem:identity];
    }
    [menu addItem:NSMenuItem.separatorItem];
    self.captureStatus = [[NSMenuItem alloc] initWithTitle:@"Choose a source for this extension and destination. It stays available until screen capture is turned off." action:nil keyEquivalent:@""];
    self.captureStatus.enabled = NO;
    [menu addItem:self.captureStatus];
    NSMenuItem *cancel = [[NSMenuItem alloc] initWithTitle:@"Cancel This Capture" action:@selector(discard:) keyEquivalent:@""];
    cancel.target = self;
    [menu addItem:cancel];
    self.captureIndicator.menu = menu;
    [NSWorkspace.sharedWorkspace.notificationCenter addObserver:self selector:@selector(sessionUnavailable:)
        name:NSWorkspaceSessionDidResignActiveNotification object:nil];
    [NSWorkspace.sharedWorkspace.notificationCenter addObserver:self selector:@selector(sessionUnavailable:)
        name:NSWorkspaceScreensDidSleepNotification object:nil];
    [NSDistributedNotificationCenter.defaultCenter addObserver:self selector:@selector(sessionUnavailable:)
        name:@"com.apple.screenIsLocked" object:nil];
    self.timer = [NSTimer scheduledTimerWithTimeInterval:0.25 target:self selector:@selector(tick:) userInfo:nil repeats:YES];
    [NSRunLoop.mainRunLoop addTimer:self.timer forMode:NSRunLoopCommonModes];
    if (self.savedSource.length && CGPreflightScreenCaptureAccess()) [self restoreSource];
    else [self showSetup];
}

- (void)showSetup {
    if (self.savedSource.length) { self.invalidateApproval(self.context); self.savedSource = nil; }
    self.remembering = self.canRemember;
    if (self.canRemember || self.requestedDisplay.length) [self screenRecordingAccess:nil];
    else [self chooseSource:nil];
}

- (void)restoreSource {
    NSDictionary *saved = [NSJSONSerialization JSONObjectWithData:[self.savedSource dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    if (![saved isKindOfClass:NSDictionary.class]) { [self showSetup]; return; }
    if (self.requestedDisplay.length && ![saved[@"display"] isEqual:self.requestedDisplay]) { [self showSetup]; return; }
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *content, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (atomic_load(&self->_completed)) return;
            if (!CGPreflightScreenCaptureAccess()) { [self showSetup]; return; }
            SCContentFilter *filter = nil;
            if ([saved[@"display"] isKindOfClass:NSString.class]) {
                for (SCDisplay *display in content.displays) {
                    CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(display.displayID);
                    NSString *identity = uuid ? CFBridgingRelease(CFUUIDCreateString(NULL, uuid)) : nil;
                    if (uuid) CFRelease(uuid);
                    if ([identity isEqual:saved[@"display"]]) {
                        filter = [self filterForDisplay:display content:content];
                        break;
                    }
                }
            } else {
                for (SCWindow *window in content.windows) {
                    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:window.owningApplication.processID];
                    // Window IDs can be reused. A window grant lasts only for this native process and owning app lifetime.
                    if ([saved[@"session"] isEqual:NativeSourceSession()] && [saved[@"window"] isEqual:@(window.windowID)]
                        && [saved[@"pid"] isEqual:@(window.owningApplication.processID)] && app.launchDate
                        && [saved[@"launch"] isEqual:@(app.launchDate.timeIntervalSince1970)]) {
                        filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window]; break;
                    }
                }
            }
            if (error || !filter) { [self showSetup]; return; }
            self->_usingPermissionedSources = YES;
            self.selectedSource = self.savedSource;
            self.remembering = YES;
            self.requestedStyle = filter.style;
            [self captureFilter:filter];
        });
    }];
}

- (void)updateStatus:(NSString *)status {
    self.captureStatus.title = status;
}

- (void)screenRecordingAccess:(id)sender {
    if (atomic_load(&_completed) || _sourceChosen || _loadingSources) return;
    if (NSProcessInfo.processInfo.systemUptime >= self.expiresAt) { [self finishOutcome:2]; return; }
    if (!CGPreflightScreenCaptureAccess()) {
        // The OS owns the only permission prompt. No Lumiverse capture window is needed.
        BOOL granted = CGRequestScreenCaptureAccess();
        NSLog(@"[Lumiverse capture] requested screen-recording access: result=%d preflight=%d", granted, CGPreflightScreenCaptureAccess());
        if (atomic_load(&_completed)) return;
        if (NSProcessInfo.processInfo.systemUptime >= self.expiresAt) { [self finishOutcome:2]; return; }
        if (!CGPreflightScreenCaptureAccess()) { [self finishOutcome:1]; return; }
    }
    _loadingSources = YES;
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *content, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (atomic_load(&self->_completed)) return;
            self->_loadingSources = NO;
            if (!CGPreflightScreenCaptureAccess()) { [self finishOutcome:1]; return; }
            if (error || !content) { [self captureFailed:error]; return; }
            self.permissionedContent = content;
            self->_usingPermissionedSources = YES;
            NSMenu *sources = [NSMenu new];
            sources.autoenablesItems = NO;
            self.sourceMenu = sources;
            NSMenuItem *heading = [[NSMenuItem alloc] initWithTitle:self.requestedDisplay.length ? @"Approve the selected display for Lumiverse" : @"Choose a source for Lumiverse" action:nil keyEquivalent:@""];
            heading.enabled = NO;
            [sources addItem:heading];
            if (self.requestedDisplay.length) {
                for (NSString *line in [self.summary componentsSeparatedByString:@"\n"]) {
                    NSMenuItem *detail = [[NSMenuItem alloc] initWithTitle:line action:nil keyEquivalent:@""];
                    detail.enabled = NO;
                    detail.toolTip = self.consent;
                    [sources addItem:detail];
                }
            }
            [sources addItem:NSMenuItem.separatorItem];
            NSUInteger displayIndex = 0;
            BOOL foundRequestedDisplay = NO;
            for (SCDisplay *display in content.displays) {
                if (displayIndex >= 16) break;
                if (self.requestedDisplay.length && ![DisplayIdentity(display.displayID) isEqual:self.requestedDisplay]) continue;
                foundRequestedDisplay = YES;
                NSString *title = [NSString stringWithFormat:@"Entire Display %lu — %ld × %ld", ++displayIndex, display.width, display.height];
                if (self.requestedDisplay.length) title = [NSString stringWithFormat:@"Share selected display — %ld × %ld", display.width, display.height];
                NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:@selector(selectSource:) keyEquivalent:@""];
                item.target = self;
                item.representedObject = display;
                [sources addItem:item];
            }
            if (self.requestedDisplay.length && !foundRequestedDisplay) { [self finishOutcome:4]; return; }
            for (SCWindow *window in content.windows) {
                if (self.requestedDisplay.length) break;
                if (sources.numberOfItems >= 258) break;
                if (!window.isOnScreen || window.windowLayer != 0 || !window.owningApplication
                    || window.owningApplication.processID == getpid() || CGRectIsEmpty(window.frame)) continue;
                NSString *title = [NSString stringWithFormat:@"%@ — %@", window.owningApplication.applicationName, window.title ?: @"Untitled window"];
                if (title.length > 160) title = [title substringToIndex:160];
                NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:@selector(selectSource:) keyEquivalent:@""];
                item.target = self;
                item.representedObject = window;
                [sources addItem:item];
            }
            [self updateStatus:@"Choose a display or window. Selecting it starts capture and remembers the source."];
            [sources popUpMenuPositioningItem:nil atLocation:NSEvent.mouseLocation inView:nil];
            self.sourceMenu = nil;
            if (!self->_sourceChosen && !atomic_load(&self->_completed)) [self finishOutcome:2];
        });
    }];
}

- (SCContentFilter *)filterForDisplay:(SCDisplay *)display content:(SCShareableContent *)content {
    NSMutableArray<SCRunningApplication *> *excluded = [NSMutableArray new];
    for (SCRunningApplication *application in content.applications) {
        if (application.processID == getpid()) [excluded addObject:application];
    }
    return [[SCContentFilter alloc] initWithDisplay:display excludingApplications:excluded exceptingWindows:@[]];
}

- (void)selectSource:(NSMenuItem *)sender {
    if (atomic_load(&_completed) || _sourceChosen || !_usingPermissionedSources) return;
    if (!CGPreflightScreenCaptureAccess()) { [self finishOutcome:1]; return; }
    id source = sender.representedObject;
    SCContentFilter *filter = nil;
    NSDictionary *identity = nil;
    if ([source isKindOfClass:SCDisplay.class]) {
        self.requestedStyle = SCShareableContentStyleDisplay;
        filter = [self filterForDisplay:source content:self.permissionedContent];
        CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(((SCDisplay *)source).displayID);
        NSString *displayID = uuid ? CFBridgingRelease(CFUUIDCreateString(NULL, uuid)) : nil;
        if (uuid) CFRelease(uuid);
        if (displayID) identity = @{@"display":displayID};
    } else if ([source isKindOfClass:SCWindow.class]) {
        SCWindow *window = source;
        self.requestedStyle = SCShareableContentStyleWindow;
        filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
        NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:window.owningApplication.processID];
        if (app.launchDate) identity = @{@"session":NativeSourceSession(), @"window":@(window.windowID),
            @"pid":@(window.owningApplication.processID), @"launch":@(app.launchDate.timeIntervalSince1970)};
    }
    if (!filter) { [self finishOutcome:4]; return; }
    if (identity) self.selectedSource = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:identity options:0 error:nil] encoding:NSUTF8StringEncoding];
    [self.sourceMenu cancelTracking];
    [self captureFilter:filter];
}

- (void)chooseSource:(id)sender {
    if (atomic_load(&_completed) || _sourceChosen) return;
    // Compatibility with servers that cannot scope a persistent approval.
    SCContentSharingPicker *picker = SCContentSharingPicker.sharedPicker;
    [picker removeObserver:self];
    picker.active = NO;
    SCContentSharingPickerConfiguration *configuration = [SCContentSharingPickerConfiguration new];
    configuration.allowedPickerModes = SCContentSharingPickerModeSingleDisplay | SCContentSharingPickerModeSingleWindow;
    configuration.allowsChangingSelectedContent = NO;
    if (NSBundle.mainBundle.bundleIdentifier) configuration.excludedBundleIDs = @[NSBundle.mainBundle.bundleIdentifier];
    picker.defaultConfiguration = configuration;
    picker.maximumStreamCount = @1;
    [picker addObserver:self];
    picker.active = YES;
    [picker presentPickerUsingContentStyle:self.requestedStyle];
}

- (void)discard:(id)sender { [self finishOutcome:2]; }
- (void)sessionUnavailable:(NSNotification *)notification {
    dispatch_async(dispatch_get_main_queue(), ^{ [self finishOutcome:2]; });
}

- (void)tick:(NSTimer *)timer {
    if (atomic_load(&_completed)) return;
    NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
    if (now >= self.expiresAt) { [self finishOutcome:2]; return; }
    if (_usingPermissionedSources && !CGPreflightScreenCaptureAccess()) { [self finishOutcome:1]; return; }
    if (self.outputURL) {
        NSNumber *size = [NSFileManager.defaultManager attributesOfItemAtPath:self.outputURL.path error:nil][NSFileSize];
        if (size.unsignedLongLongValue > self.maximumBytes) { [self finishOutcome:4]; return; }
    }
    if (self.recordStartedAt > 0 && !_finishing) {
        NSTimeInterval elapsed = now - self.recordStartedAt;
        [self updateStatus:[NSString stringWithFormat:@"Recording — %.1f / %llu seconds. No audio. Cancel This Capture stops only this request.", MIN(elapsed, self.seconds), self.seconds]];
        self.captureIndicator.button.title = [NSString stringWithFormat:@" %.0fs", ceil(MAX(0, self.seconds - elapsed))];
        if (elapsed >= self.seconds || (self.finishRequested && elapsed >= 1.0 / 30.0)) [self stopRecording];
    }
}

- (void)contentSharingPicker:(SCContentSharingPicker *)picker didCancelForStream:(SCStream *)stream {
    dispatch_async(dispatch_get_main_queue(), ^{ [self finishOutcome:2]; });
}
- (void)contentSharingPickerStartDidFailWithError:(NSError *)error {
    dispatch_async(dispatch_get_main_queue(), ^{ [self captureFailed:error]; });
}

- (void)contentSharingPicker:(SCContentSharingPicker *)picker didUpdateWithFilter:(SCContentFilter *)filter forStream:(SCStream *)stream {
    dispatch_async(dispatch_get_main_queue(), ^{ [self captureFilter:filter]; });
}

- (void)captureFailed:(NSError *)error {
    if (atomic_load(&_completed)) return;
    NSLog(@"[Lumiverse capture] native capture error: domain=%@ code=%ld screen-recording-access=%d", error.domain, error.code, CGPreflightScreenCaptureAccess());
    BOOL denied = [error.domain isEqualToString:SCStreamErrorDomain] && error.code == SCStreamErrorUserDeclined;
    [self finishOutcome:denied ? 1 : 4];
}

- (void)captureFilter:(SCContentFilter *)filter {
    if (atomic_load(&_completed)) return;
    if (_sourceChosen) { [self finishOutcome:2]; return; }
    if (NSProcessInfo.processInfo.systemUptime >= self.expiresAt) { [self finishOutcome:2]; return; }
    if (_usingPermissionedSources && !CGPreflightScreenCaptureAccess()) { [self finishOutcome:1]; return; }
    NSLog(@"[Lumiverse capture] source: requested-style=%ld selected-style=%ld permissioned-list=%d", self.requestedStyle, filter.style, _usingPermissionedSources);
    if (!filter || (filter.style != SCShareableContentStyleDisplay && filter.style != SCShareableContentStyleWindow)
        || (_usingPermissionedSources && filter.style != self.requestedStyle)) { [self finishOutcome:4]; return; }
    _sourceChosen = YES;
    if (self.remembering && self.selectedSource.length) self.rememberSource(self.context, self.selectedSource.UTF8String);
    self.permissionedContent = nil;
    CGSize size = filter.contentRect.size;
    double scale = filter.pointPixelScale;
    if (!isfinite(size.width) || !isfinite(size.height) || !isfinite(scale) || size.width <= 0 || size.height <= 0 || scale <= 0) {
        [self finishOutcome:4]; return;
    }
    double pixelWidth = size.width * scale;
    double pixelHeight = size.height * scale;
    if (!isfinite(pixelWidth) || !isfinite(pixelHeight)) { [self finishOutcome:4]; return; }
    double ratio = MIN(1.0, MIN(1920.0 / pixelWidth, 1080.0 / pixelHeight));
    self.width = MAX(2, ((uint32_t)(pixelWidth * ratio) / 2) * 2);
    self.height = MAX(2, ((uint32_t)(pixelHeight * ratio) / 2) * 2);
    if ((uint64_t)self.width * self.height > self.maximumPixels) { [self finishOutcome:4]; return; }
    SCStreamConfiguration *configuration = [SCStreamConfiguration new];
    configuration.width = self.width;
    configuration.height = self.height;
    configuration.minimumFrameInterval = CMTimeMake(1, 30);
    configuration.queueDepth = 3;
    configuration.pixelFormat = kCVPixelFormatType_32BGRA;
    configuration.showsCursor = YES;
    configuration.capturesAudio = NO;
    if (@available(macOS 15.0, *)) configuration.captureMicrophone = NO;
    if (self.video) {
        [self startRecordingWithFilter:filter configuration:configuration];
    } else {
        [SCScreenshotManager captureImageWithFilter:filter configuration:configuration completionHandler:^(CGImageRef image, NSError *error) {
            if (image) CGImageRetain(image);
            dispatch_async(dispatch_get_main_queue(), ^{
                if (!atomic_load(&self->_completed)) {
                    if (error || !image) { [self captureFailed:error]; }
                    else {
                        NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:image];
                        NSData *encoded = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
                        if (!encoded.length || encoded.length > self.maximumBytes) [self finishOutcome:4];
                        else {
                            self.imageData = [encoded mutableCopy];
                            [self share:nil];
                        }
                    }
                }
                if (image) CGImageRelease(image);
            });
        }];
    }
}

- (void)share:(id)sender {
    if (atomic_load(&_completed) || !_sourceChosen) return;
    if (NSProcessInfo.processInfo.systemUptime >= self.expiresAt) { [self finishOutcome:2]; return; }
    if (_usingPermissionedSources && !CGPreflightScreenCaptureAccess()) { [self finishOutcome:1]; return; }
    [self finishOutcome:0];
}

- (void)startRecordingWithFilter:(SCContentFilter *)filter configuration:(SCStreamConfiguration *)configuration {
    if (!(lumiverse_capture_capabilities() & 2)) { [self finishOutcome:3]; return; }
    NSString *template = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"lumiverse-capture-%d-XXXXXX", getpid()]];
    char *path = strdup(template.fileSystemRepresentation);
    char *directory = mkdtemp(path);
    if (!directory) { free(path); [self finishOutcome:4]; return; }
    self.directory = [NSURL fileURLWithFileSystemRepresentation:directory isDirectory:YES relativeToURL:nil];
    free(path);
    self.outputURL = [self.directory URLByAppendingPathComponent:@"capture.mp4"];
    NSError *error = nil;
    self.writer = [[AVAssetWriter alloc] initWithURL:self.outputURL fileType:AVFileTypeMPEG4 error:&error];
    NSDictionary *settings = @{
        AVVideoCodecKey: AVVideoCodecTypeH264,
        AVVideoWidthKey: @(self.width), AVVideoHeightKey: @(self.height),
        AVVideoEncoderSpecificationKey: @{
            (__bridge NSString *)kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: @YES,
            (__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: @YES,
        },
        AVVideoCompressionPropertiesKey: @{
            AVVideoAverageBitRateKey: @8000000,
            AVVideoExpectedSourceFrameRateKey: @30,
            AVVideoMaxKeyFrameIntervalKey: @30,
            AVVideoAllowFrameReorderingKey: @NO,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264MainAutoLevel,
        }
    };
    self.input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:settings];
    self.input.expectsMediaDataInRealTime = YES;
    if (error || !self.writer || ![self.writer canAddInput:self.input]) { [self finishOutcome:4]; return; }
    [self.writer addInput:self.input];
    if (![self.writer startWriting]) { [self finishOutcome:4]; return; }
    chmod(self.outputURL.fileSystemRepresentation, 0600);
    self.stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:self];
    if (![self.stream addStreamOutput:self type:SCStreamOutputTypeScreen sampleHandlerQueue:self.outputQueue error:&error]) {
        [self captureFailed:error]; return;
    }
    [self.stream startCaptureWithCompletionHandler:^(NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (atomic_load(&self->_completed)) return;
            if (error) { [self captureFailed:error]; return; }
            self.recordStartedAt = NSProcessInfo.processInfo.systemUptime;
            [self updateStatus:@"Recording selected source with hardware H.264. No audio."];
        });
    }];
}

- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)buffer ofType:(SCStreamOutputType)type {
    if (atomic_load(&_cancelled) || _finishing || type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(buffer)) return;
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, false);
    if (!attachments || !CFArrayGetCount(attachments)) return;
    NSDictionary *information = (__bridge NSDictionary *)CFArrayGetValueAtIndex(attachments, 0);
    NSNumber *status = information[SCStreamFrameInfoStatus];
    if (status.integerValue == SCFrameStatusBlank || status.integerValue == SCFrameStatusSuspended || status.integerValue == SCFrameStatusStopped) {
        dispatch_async(dispatch_get_main_queue(), ^{ [self finishOutcome:2]; }); return;
    }
    if (!status || status.integerValue != SCFrameStatusComplete || !self.input.readyForMoreMediaData) return;
    CMTime timestamp = CMSampleBufferGetPresentationTimeStamp(buffer);
    if (!CMTIME_IS_NUMERIC(timestamp)) return;
    if (!_sessionStarted) {
        _firstTime = timestamp;
        [self.writer startSessionAtSourceTime:timestamp];
        _sessionStarted = YES;
    }
    if (CMTimeGetSeconds(CMTimeSubtract(timestamp, _firstTime)) >= self.seconds) return;
    if (![self.input appendSampleBuffer:buffer]) {
        dispatch_async(dispatch_get_main_queue(), ^{ [self finishOutcome:4]; }); return;
    }
    _lastTime = timestamp;
    if (_lastBuffer) CFRelease(_lastBuffer);
    _lastBuffer = (CMSampleBufferRef)CFRetain(buffer);
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    dispatch_async(dispatch_get_main_queue(), ^{
        if ([error.domain isEqualToString:SCStreamErrorDomain] && error.code == SCStreamErrorUserStopped) [self finishOutcome:2];
        else [self captureFailed:error];
    });
}

- (void)stopRecording {
    if (self.recordStartedAt == 0 || atomic_load(&_completed)) return;
    self.duration = MIN(self.seconds, NSProcessInfo.processInfo.systemUptime - self.recordStartedAt);
    self.recordStartedAt = 0;
    [self updateStatus:@"Finishing the recording locally. Nothing has been uploaded."];
    [self.stream stopCaptureWithCompletionHandler:^(NSError *error) {
        dispatch_async(self.outputQueue, ^{
            if (atomic_load(&self->_cancelled)) return;
            self->_finishing = YES;
            if (error || !self->_sessionStarted || !self->_lastBuffer || self.duration <= 0) {
                dispatch_async(dispatch_get_main_queue(), ^{ [self finishOutcome:4]; }); return;
            }
            CMTime end = CMTimeAdd(self->_firstTime, CMTimeMakeWithSeconds(self.duration, 60000));
            CMTime finalTime = CMTimeSubtract(end, CMTimeMake(1, 30));
            if (CMTimeCompare(finalTime, self->_lastTime) > 0 && self.input.readyForMoreMediaData) {
                CMSampleTimingInfo timing = {CMTimeMake(1, 30), finalTime, kCMTimeInvalid};
                CMSampleBufferRef repeated = NULL;
                if (CMSampleBufferCreateCopyWithNewTiming(kCFAllocatorDefault, self->_lastBuffer, 1, &timing, &repeated) == noErr) {
                    [self.input appendSampleBuffer:repeated];
                    CFRelease(repeated);
                }
            }
            [self.writer endSessionAtSourceTime:end];
            [self.input markAsFinished];
            [self.writer finishWritingWithCompletionHandler:^{
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (atomic_load(&self->_completed)) return;
                    NSNumber *size = [NSFileManager.defaultManager attributesOfItemAtPath:self.outputURL.path error:nil][NSFileSize];
                    if (self.writer.status != AVAssetWriterStatusCompleted || !size || size.unsignedLongLongValue == 0 || size.unsignedLongLongValue > self.maximumBytes) {
                        [self finishOutcome:4]; return;
                    }
                    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:self.outputURL options:@{AVURLAssetPreferPreciseDurationAndTimingKey: @YES}];
                    self.validationAsset = asset;
                    [asset loadTracksWithMediaType:AVMediaTypeAudio completionHandler:^(NSArray<AVAssetTrack *> *tracks, NSError *error) {
                        dispatch_async(self.outputQueue, ^{
                            if (atomic_load(&self->_cancelled)) return;
                            double duration = error ? NAN : CMTimeGetSeconds(asset.duration);
                            dispatch_async(dispatch_get_main_queue(), ^{
                                if (atomic_load(&self->_completed)) return;
                                self.validationAsset = nil;
                                if (error || !tracks || tracks.count != 0 || !isfinite(duration) || duration <= 0 || duration > self.seconds) {
                                    [self finishOutcome:4]; return;
                                }
                                self.duration = duration;
                                [self share:nil];
                            });
                        });
                    }];
                });
            }];
        });
    }];
}

- (void)finishOutcome:(uint32_t)outcome {
    if (atomic_exchange(&_completed, true)) return;
    atomic_store(&_cancelled, true);
    [self.timer invalidate];
    self.timer = nil;
    self.captureIndicator.menu = nil;
    if (self.captureIndicator) [NSStatusBar.systemStatusBar removeStatusItem:self.captureIndicator];
    self.captureIndicator = nil;
    [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:self];
    [NSDistributedNotificationCenter.defaultCenter removeObserver:self];
    SCContentSharingPicker.sharedPicker.active = NO;
    [SCContentSharingPicker.sharedPicker removeObserver:self];
    [self.validationAsset cancelLoading];
    self.validationAsset = nil;
    self.permissionedContent = nil;
    [self.sourceMenu cancelTracking];
    self.sourceMenu = nil;
    void (^cleanup)(void) = ^{
        dispatch_async(self.outputQueue, ^{
            if (self.stream) [self.stream removeStreamOutput:self type:SCStreamOutputTypeScreen error:nil];
            if (self.writer.status == AVAssetWriterStatusWriting) [self.writer cancelWriting];
            dispatch_async(dispatch_get_main_queue(), ^{
                NSMutableData *data = self.imageData;
                uint32_t finalOutcome = outcome;
                if (outcome == 0 && self.video) {
                    NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:self.outputURL.path error:nil];
                    NSUInteger size = [attributes[NSFileSize] unsignedIntegerValue];
                    if (size == 0 || size > self.maximumBytes) finalOutcome = 4;
                    else data = [NSMutableData dataWithContentsOfURL:self.outputURL];
                }
                if (finalOutcome == 0 && (!data.length || data.length > self.maximumBytes)) finalOutcome = 4;
                if (self.directory) [NSFileManager.defaultManager removeItemAtURL:self.directory error:nil];
                CaptureCallback callback = self.callback;
                self.callback = NULL;
                if (currentCapture == self) currentCapture = nil;
                callback(self.context, finalOutcome, finalOutcome == 0 ? data.bytes : NULL,
                    finalOutcome == 0 ? data.length : 0, self.width, self.height, self.video ? self.duration : 0, self.remembering ? self.selectedSource.UTF8String : NULL);
                if (data.length) [data resetBytesInRange:NSMakeRange(0, data.length)];
                self.imageData = nil;
                self.stream = nil;
                self.writer = nil;
                self.input = nil;
            });
        });
    };
    if (self.stream) [self.stream stopCaptureWithCompletionHandler:^(NSError *error) { (void)error; cleanup(); }];
    else cleanup();
}
@end

void lumiverse_capture_begin(const char *request_id, const char *consent, const char *summary, const char *source, const char *display, bool can_remember, void (*invalidate)(void *), void (*remember)(void *, const char *), bool video, uint64_t seconds,
    size_t max_bytes, uint64_t max_pixels, uint64_t remaining_ms, CaptureCallback callback, void *context) {
    if (@available(macOS 14.0, *)) {
        if (currentCapture || remaining_ms == 0 || remaining_ms > 300000 || max_bytes == 0 || max_pixels == 0
            || max_pixels > 16777216 || max_bytes > (video ? 134217728 : 8388608)
            || (video && (!(lumiverse_capture_capabilities() & 2) || seconds == 0 || seconds > 120))) {
            callback(context, 3, NULL, 0, 0, 0, 0, NULL); return;
        }
        LumiverseCapture *capture = [LumiverseCapture new];
        capture.requestID = [NSString stringWithUTF8String:request_id];
        capture.consent = [NSString stringWithUTF8String:consent];
        capture.summary = [NSString stringWithUTF8String:summary];
        capture.savedSource = source ? [NSString stringWithUTF8String:source] : nil;
        capture.requestedDisplay = display ? [NSString stringWithUTF8String:display] : nil;
        capture.canRemember = can_remember;
        capture.invalidateApproval = invalidate;
        capture.rememberSource = remember;
        capture.video = video;
        capture.seconds = seconds;
        capture.maximumBytes = max_bytes;
        capture.maximumPixels = max_pixels;
        capture.expiresAt = NSProcessInfo.processInfo.systemUptime + remaining_ms / 1000.0;
        capture.callback = callback;
        capture.context = context;
        currentCapture = capture;
        [capture start];
    } else callback(context, 3, NULL, 0, 0, 0, 0, NULL);
}

void lumiverse_capture_cancel(const char *request_id) {
    if (@available(macOS 14.0, *)) {
        if ([currentCapture.requestID isEqualToString:[NSString stringWithUTF8String:request_id]]) [currentCapture finishOutcome:2];
    }
}

void lumiverse_capture_finish(const char *request_id) {
    if (@available(macOS 14.0, *)) {
        if (currentCapture.video && [currentCapture.requestID isEqualToString:[NSString stringWithUTF8String:request_id]]) {
            currentCapture.finishRequested = YES;
        }
    }
}

// Read-only source discovery. Preflight never requests permission; no frames or stream are created.
uint32_t lumiverse_capture_source_status(const char *source) {
    if (!CGPreflightScreenCaptureAccess()) return 2;
    if (!source) return 0;
    NSData *data = [[NSString stringWithUTF8String:source] dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *saved = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (![saved isKindOfClass:NSDictionary.class]) return 0;
    if ([saved[@"display"] isKindOfClass:NSString.class]) {
        CFUUIDRef uuid = CFUUIDCreateFromString(NULL, (__bridge CFStringRef)saved[@"display"]);
        if (!uuid) return 0;
        CGDirectDisplayID display = CGDisplayGetDisplayIDFromUUID(uuid);
        CFRelease(uuid);
        return display && CGDisplayIsActive(display) ? 1 : 0;
    }
    if (![saved[@"session"] isEqual:NativeSourceSession()] || ![saved[@"pid"] isKindOfClass:NSNumber.class]) return 0;
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:[saved[@"pid"] intValue]];
    if (!app.launchDate || ![saved[@"launch"] isEqual:@(app.launchDate.timeIntervalSince1970)]) return 0;
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    for (NSDictionary *window in windows) {
        if ([window[(__bridge NSString *)kCGWindowNumber] isEqual:saved[@"window"]]
            && [window[(__bridge NSString *)kCGWindowOwnerPID] isEqual:saved[@"pid"]]) return 1;
    }
    return 0;
}

void lumiverse_capture_shutdown(void) {
    if (@available(macOS 14.0, *)) {
        if (currentCapture.directory) [NSFileManager.defaultManager removeItemAtURL:currentCapture.directory error:nil];
        [currentCapture finishOutcome:2];
    }
}
