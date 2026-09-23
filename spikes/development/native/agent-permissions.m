#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdio.h>

int main(void) {
    // Readiness only, in the launching automation application's context.
    // Neither API requests consent, captures a screen, nor performs UI actions.
    if (!AXIsProcessTrusted()) {
        puts("ACCESSIBILITY_PERMISSION_REQUIRED");
        return 2;
    }
    if (!CGPreflightScreenCaptureAccess()) {
        puts("SCREEN_RECORDING_PERMISSION_REQUIRED");
        return 2;
    }
    puts("READY");
    return 0;
}
