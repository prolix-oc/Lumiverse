// macOS system-audio capture: a Core Audio process tap (macOS 14.2+) on everything the device plays.
//
// This file is only the device. When to work (silence, hidden window, pacing, stop) lives in engine.rs.
//
// Why a process tap rather than ScreenCaptureKit: it needs only the "System Audio Recording" permission (an orange
// indicator in the menu bar), not Screen Recording, and it carries no video stream.
//
// The audio callback runs on a real-time thread. It writes mono or complete stereo frames into a lock-free ring;
// Rust drains the ring at the frame rate. Samples never leave this process: Rust turns them into levels
// and bands and only those are sent on.
//
// Hidden window: Rust asks for the IO to be stopped (AudioDeviceStop) and started again, so nothing runs while
// nobody is looking. Everything is ARC; the ring is plain C so the real-time block touches no Objective-C.

#import <AppKit/AppKit.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#include <stdatomic.h>
#include <stdlib.h>

enum {
    kLumiverseTapOK = 0,
    kLumiverseTapUnavailableOS = 1,
    kLumiverseTapNoOutputDevice = 2,
    kLumiverseTapTapFailed = 3,
    kLumiverseTapAggregateFailed = 4,
    kLumiverseTapUnsupportedFormat = 5,
    kLumiverseTapStartFailed = 6,
};

// One second of mono at 64 kHz is far more than the 250 ms Rust waits between drains.
#define RING_CAPACITY (1u << 16)

typedef struct {
    float *data;
    UInt32 channels; // stored floats per frame: 1 for mono, 2 for stereo
    _Atomic size_t head; // written by the real-time thread
    _Atomic size_t tail; // written by the reader
} Ring;

static inline void ring_write(Ring *ring, float left, float right) {
    size_t head = atomic_load_explicit(&ring->head, memory_order_relaxed);
    size_t tail = atomic_load_explicit(&ring->tail, memory_order_acquire);
    if (head - tail >= RING_CAPACITY) return; // the reader fell behind: drop rather than block
    size_t at = (head & (RING_CAPACITY - 1)) * ring->channels;
    ring->data[at] = left;
    if (ring->channels == 2) ring->data[at + 1] = right;
    atomic_store_explicit(&ring->head, head + 1, memory_order_release);
}

// A tap-only aggregate has exactly the tap's channels. Validate the actual IO buffers rather than assuming their
// layout from the tap's ASBD: Core Audio can supply one interleaved buffer or several planar buffers.
static void TapInputToRing(Ring *ring, const AudioBufferList *input, UInt32 tapChannels) {
    if (!input || input->mNumberBuffers == 0 || tapChannels == 0) return;
    UInt32 channels = 0;
    UInt32 frames = UINT32_MAX;
    for (UInt32 b = 0; b < input->mNumberBuffers; b++) {
        const AudioBuffer *buffer = &input->mBuffers[b];
        if (!buffer->mData || buffer->mNumberChannels == 0 || buffer->mNumberChannels > tapChannels - channels) return;
        const UInt32 stride = sizeof(float) * buffer->mNumberChannels;
        if (buffer->mDataByteSize % stride != 0) return;
        channels += buffer->mNumberChannels;
        frames = MIN(frames, buffer->mDataByteSize / stride);
    }
    if (channels != tapChannels) return;
    if (ring->channels == 1) {
        for (UInt32 frame = 0; frame < frames; frame++) {
            float sum = 0;
            for (UInt32 b = 0; b < input->mNumberBuffers; b++) {
                const AudioBuffer *buffer = &input->mBuffers[b];
                const float *samples = buffer->mData;
                for (UInt32 c = 0; c < buffer->mNumberChannels; c++) sum += samples[frame * buffer->mNumberChannels + c];
            }
            ring_write(ring, sum / channels, 0);
        }
        return;
    }
    for (UInt32 frame = 0; frame < frames; frame++) {
        float left = 0, right = 0;
        UInt32 index = 0;
        for (UInt32 b = 0; b < input->mNumberBuffers; b++) {
            const AudioBuffer *buffer = &input->mBuffers[b];
            const float *samples = buffer->mData;
            for (UInt32 c = 0; c < buffer->mNumberChannels; c++) {
                float sample = samples[frame * buffer->mNumberChannels + c];
                if (index == 0) left = sample;
                if (index == 1) right = sample;
                index++;
            }
        }
        ring_write(ring, left, channels == 1 ? left : right);
    }
}

static AudioObjectPropertyAddress DefaultOutputAddress(void) {
    AudioObjectPropertyAddress address = {
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
    };
    return address;
}

API_AVAILABLE(macos(14.2))
@interface LumiverseTapSession : NSObject {
@public
    AudioObjectID tap;
    AudioObjectID aggregate;
    AudioDeviceIOProcID proc;
    dispatch_queue_t queue;
    Ring *ring;
    UInt32 sampleRate;
    BOOL running;
    AudioObjectPropertyListenerBlock listener;
    _Atomic bool outputChanged;
}
@end

@implementation LumiverseTapSession
@end

API_AVAILABLE(macos(14.2)) static void TearDown(LumiverseTapSession *session) {
    if (session->listener) {
        AudioObjectPropertyAddress address = DefaultOutputAddress();
        AudioObjectRemovePropertyListenerBlock(kAudioObjectSystemObject, &address, session->queue, session->listener);
        session->listener = nil;
    }
    if (session->aggregate != kAudioObjectUnknown && session->proc) {
        if (session->running) AudioDeviceStop(session->aggregate, session->proc);
        AudioDeviceDestroyIOProcID(session->aggregate, session->proc);
        session->proc = NULL;
    }
    session->running = NO;
    if (session->aggregate != kAudioObjectUnknown) {
        AudioHardwareDestroyAggregateDevice(session->aggregate);
        session->aggregate = kAudioObjectUnknown;
    }
    if (session->tap != kAudioObjectUnknown) {
        AudioHardwareDestroyProcessTap(session->tap);
        session->tap = kAudioObjectUnknown;
    }
    if (session->ring) {
        free(session->ring->data);
        free(session->ring);
        session->ring = NULL;
    }
}

bool lumiverse_audio_tap_available(void) {
    if (@available(macOS 14.2, *)) return true;
    return false;
}

// Opens a stopped tap. The caller starts it with lumiverse_audio_tap_set_running. Returns NULL and a status on failure.
void *lumiverse_audio_tap_open(int *status, bool stereo) {
    *status = kLumiverseTapUnavailableOS;
    if (@available(macOS 14.2, *)) {
        LumiverseTapSession *session = [LumiverseTapSession new];
        session->tap = kAudioObjectUnknown;
        session->aggregate = kAudioObjectUnknown;
        session->proc = NULL;
        atomic_init(&session->outputChanged, false);

        // Require an output, but do not add the hardware device to the aggregate: a duplex output would also donate
        // its microphone inputs. The process tap supplies the aggregate's only input streams and their clock.
        AudioObjectPropertyAddress outputAddress = DefaultOutputAddress();
        AudioDeviceID output = kAudioObjectUnknown;
        UInt32 size = sizeof(output);
        if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &outputAddress, 0, NULL, &size, &output) != noErr ||
            output == kAudioObjectUnknown) {
            *status = kLumiverseTapNoOutputDevice;
            return NULL;
        }
        // Everything the device plays, mixed to stereo, not muted, and invisible to other apps.
        CATapDescription *description = [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:@[]];
        description.name = @"Lumiverse system audio analysis";
        description.privateTap = YES;
        description.muteBehavior = CATapUnmuted;
        if (AudioHardwareCreateProcessTap(description, &session->tap) != noErr) {
            // Usually: the user has not allowed (or has denied) System Audio Recording.
            *status = kLumiverseTapTapFailed;
            return NULL;
        }

        NSDictionary *aggregateDescription = @{
            @kAudioAggregateDeviceNameKey: @"Lumiverse analysis tap",
            @kAudioAggregateDeviceUIDKey: [NSUUID UUID].UUIDString,
            @kAudioAggregateDeviceIsPrivateKey: @YES,
            @kAudioAggregateDeviceIsStackedKey: @NO,
            @kAudioAggregateDeviceTapAutoStartKey: @YES,
            @kAudioAggregateDeviceSubDeviceListKey: @[],
            @kAudioAggregateDeviceTapListKey: @[ @{
                @kAudioSubTapDriftCompensationKey: @YES,
                @kAudioSubTapUIDKey: description.UUID.UUIDString,
            } ],
        };
        if (AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregateDescription, &session->aggregate) !=
            noErr) {
            TearDown(session);
            *status = kLumiverseTapAggregateFailed;
            return NULL;
        }

        AudioStreamBasicDescription format = {0};
        AudioObjectPropertyAddress formatAddress = {
            kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain,
        };
        size = sizeof(format);
        if (AudioObjectGetPropertyData(session->tap, &formatAddress, 0, NULL, &size, &format) != noErr ||
            format.mFormatID != kAudioFormatLinearPCM || !(format.mFormatFlags & kAudioFormatFlagIsFloat) ||
            format.mBitsPerChannel != 32 || format.mChannelsPerFrame == 0 || format.mSampleRate < 8000 ||
            (stereo && format.mChannelsPerFrame > 2)) {
            TearDown(session);
            *status = kLumiverseTapUnsupportedFormat;
            return NULL;
        }
        session->sampleRate = (UInt32)format.mSampleRate;
        const UInt32 tapChannels = format.mChannelsPerFrame;

        Ring *ring = calloc(1, sizeof(Ring));
        if (!ring) { TearDown(session); *status = kLumiverseTapStartFailed; return NULL; }
        ring->channels = stereo ? 2 : 1;
        ring->data = calloc(RING_CAPACITY * ring->channels, sizeof(float));
        session->ring = ring;
        if (!ring->data) { TearDown(session); *status = kLumiverseTapStartFailed; return NULL; }

        session->queue = dispatch_queue_create("chat.lumiverse.system-audio", DISPATCH_QUEUE_SERIAL);
        OSStatus created = AudioDeviceCreateIOProcIDWithBlock(
            &session->proc, session->aggregate, session->queue,
            ^(const AudioTimeStamp *now, const AudioBufferList *input, const AudioTimeStamp *inputTime,
              AudioBufferList *playback, const AudioTimeStamp *playbackTime) {
                (void)now;
                (void)inputTime;
                (void)playback;
                (void)playbackTime;
                TapInputToRing(ring, input, tapChannels);
            });
        if (created != noErr || !session->proc) {
            TearDown(session);
            *status = kLumiverseTapStartFailed;
            return NULL;
        }

        // Follow the user to another output device (headphones, a dock): Rust reopens the tap on the new one.
        __unsafe_unretained LumiverseTapSession *weakSession = session;
        session->listener = ^(UInt32 count, const AudioObjectPropertyAddress *addresses) {
            (void)count;
            (void)addresses;
            atomic_store(&weakSession->outputChanged, true);
        };
        AudioObjectAddPropertyListenerBlock(kAudioObjectSystemObject, &outputAddress, session->queue, session->listener);

        *status = kLumiverseTapOK;
        return (void *)CFBridgingRetain(session);
    }
    return NULL;
}

uint32_t lumiverse_audio_tap_sample_rate(void *handle) {
    if (@available(macOS 14.2, *)) return ((__bridge LumiverseTapSession *)handle)->sampleRate;
    return 0;
}

// Start or stop the IO. Stopped means no callbacks at all. Returns false if starting failed.
bool lumiverse_audio_tap_set_running(void *handle, bool run) {
    if (@available(macOS 14.2, *)) {
        LumiverseTapSession *session = (__bridge LumiverseTapSession *)handle;
        if (run == session->running) return true;
        OSStatus result = run ? AudioDeviceStart(session->aggregate, session->proc)
                              : AudioDeviceStop(session->aggregate, session->proc);
        if (result != noErr) return false;
        session->running = run;
        return true;
    }
    return false;
}

// Copy complete frames, returning the number of floats copied. Head/tail count frames so pairs never split.
size_t lumiverse_audio_tap_read(void *handle, float *out, size_t capacity) {
    if (@available(macOS 14.2, *)) {
        Ring *ring = ((__bridge LumiverseTapSession *)handle)->ring;
        size_t tail = atomic_load_explicit(&ring->tail, memory_order_relaxed);
        size_t head = atomic_load_explicit(&ring->head, memory_order_acquire);
        size_t available = head - tail;
        size_t frames = capacity / ring->channels;
        size_t count = available < frames ? available : frames;
        for (size_t i = 0; i < count; i++) {
            size_t at = ((tail + i) & (RING_CAPACITY - 1)) * ring->channels;
            for (UInt32 c = 0; c < ring->channels; c++) out[i * ring->channels + c] = ring->data[at + c];
        }
        atomic_store_explicit(&ring->tail, tail + count, memory_order_release);
        return count * ring->channels;
    }
    return 0;
}

bool lumiverse_audio_tap_output_changed(void *handle) {
    if (@available(macOS 14.2, *)) {
        return atomic_load(&((__bridge LumiverseTapSession *)handle)->outputChanged);
    }
    return false;
}

void lumiverse_audio_tap_close(void *handle) {
    if (@available(macOS 14.2, *)) {
        LumiverseTapSession *session = (LumiverseTapSession *)CFBridgingRelease(handle);
        TearDown(session);
    }
}

// ─── Lock and sleep ──────────────────────────────────────────────────────────────────────────────────────────────

@interface LumiverseSessionWatch : NSObject {
@public
    _Atomic bool tripped;
    NSMutableArray *tokens;
    NSMutableArray *centers;
}
@end

@implementation LumiverseSessionWatch
@end

// Watches for the screen locking, the user switching away, or the machine going to sleep.
void *lumiverse_audio_watch_open(void) {
    LumiverseSessionWatch *watch = [LumiverseSessionWatch new];
    atomic_init(&watch->tripped, false);
    watch->tokens = [NSMutableArray new];
    watch->centers = [NSMutableArray new];
    __unsafe_unretained LumiverseSessionWatch *weakWatch = watch;
    void (^trip)(NSNotification *) = ^(NSNotification *note) {
        (void)note;
        atomic_store(&weakWatch->tripped, true);
    };

    NSNotificationCenter *workspace = NSWorkspace.sharedWorkspace.notificationCenter;
    for (NSNotificationName name in @[ NSWorkspaceWillSleepNotification, NSWorkspaceSessionDidResignActiveNotification ]) {
        [watch->tokens addObject:[workspace addObserverForName:name object:nil queue:nil usingBlock:trip]];
        [watch->centers addObject:workspace];
    }
    NSNotificationCenter *distributed = NSDistributedNotificationCenter.defaultCenter;
    [watch->tokens addObject:[distributed addObserverForName:@"com.apple.screenIsLocked" object:nil queue:nil
                                                  usingBlock:trip]];
    [watch->centers addObject:distributed];
    return (void *)CFBridgingRetain(watch);
}

bool lumiverse_audio_watch_tripped(void *handle) {
    return atomic_load(&((__bridge LumiverseSessionWatch *)handle)->tripped);
}

void lumiverse_audio_watch_close(void *handle) {
    LumiverseSessionWatch *watch = (LumiverseSessionWatch *)CFBridgingRelease(handle);
    for (NSUInteger i = 0; i < watch->tokens.count; i++) {
        [watch->centers[i] removeObserver:watch->tokens[i]];
    }
}
