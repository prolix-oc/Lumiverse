#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

// Wry's macOS UI delegate creates child WebViews but does not implement
// webViewDidClose:. Forward its other behavior (new windows, dialogs, media
// permissions, file pickers) while translating browser close into a normal
// native close request. Tauri then removes the window and its WebView together.
@interface LumiversePopupCloseDelegate : NSObject <WKUIDelegate>
// Wry owns the original delegate; release it when Wry tears down the WebView.
@property(nonatomic, weak) id<WKUIDelegate> original;
@end

@implementation LumiversePopupCloseDelegate
- (BOOL)respondsToSelector:(SEL)selector {
    return [super respondsToSelector:selector] || [self.original respondsToSelector:selector];
}

- (id)forwardingTargetForSelector:(SEL)selector {
    if ([self.original respondsToSelector:selector]) return self.original;
    return [super forwardingTargetForSelector:selector];
}

- (void)webViewDidClose:(WKWebView *)webView {
    [webView.window performClose:nil];
}
@end

void lumiverse_install_popup_close_handler(void *webview_pointer) {
    WKWebView *webView = (__bridge WKWebView *)webview_pointer;
    if ([webView.UIDelegate isKindOfClass:[LumiversePopupCloseDelegate class]]) return;
    LumiversePopupCloseDelegate *delegate = [LumiversePopupCloseDelegate new];
    delegate.original = webView.UIDelegate;
    // WKWebView's delegate property is weak. Retain the forwarding delegate for
    // exactly the lifetime of this popup, without sharing it with the opener.
    static char associationKey;
    objc_setAssociatedObject(webView, &associationKey, delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    webView.UIDelegate = delegate;
}
