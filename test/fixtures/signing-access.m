#define main signingAccessMain
#import "../../spikes/development/native/signing-access.m"
#undef main
#include <assert.h>

static NSString *partitionDescription(NSArray *values) {
    NSData *data = [NSPropertyListSerialization dataWithPropertyList:@{@"Partitions": values}
        format:NSPropertyListXMLFormat_v1_0 options:0 error:NULL];
    NSMutableString *hex = [NSMutableString string];
    for (NSUInteger i = 0; i < data.length; i++) [hex appendFormat:@"%02x", ((const uint8_t *)data.bytes)[i]];
    return hex;
}

int main(void) {
    @autoreleasepool {
        // These ACL objects live only in memory. No Keychain is created,
        // searched, registered, unlocked, or changed by this fixture.
        assert(SecKeychainSetUserInteractionAllowed(false) == errSecSuccess);
        assert(allowsCodesignPartition(partitionDescription(@[@"apple-tool:"])));
        assert(allowsCodesignPartition(partitionDescription(@[@"apple:"])));
        assert(!allowsCodesignPartition(partitionDescription(@[@"teamid:TESTTEAM01"])));
        assert(!allowsCodesignPartition(@"00xz"));
        assert(!allowsCodesignPartition(@"00"));
        SecTrustedApplicationRef tool = NULL;
        assert(SecTrustedApplicationCreateFromPath("/usr/bin/codesign", &tool) == errSecSuccess);
        SecAccessRef access = NULL;
        assert(SecAccessCreate(CFSTR("synthetic-signing-test"), (__bridge CFArrayRef)@[(__bridge id)tool], &access) == errSecSuccess);
        SecACLRef sign = NULL, partition = NULL;
        assert(SecACLCreateWithSimpleContents(access, (__bridge CFArrayRef)@[(__bridge id)tool], CFSTR("sign"), 0, &sign) == errSecSuccess);
        assert(SecACLUpdateAuthorizations(sign, (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationSign]) == errSecSuccess);
        NSString *description = partitionDescription(@[@"apple-tool:"]);
        assert(SecACLCreateWithSimpleContents(access, (__bridge CFArrayRef)@[], (__bridge CFStringRef)description, 0, &partition) == errSecSuccess);
        assert(SecACLUpdateAuthorizations(partition, (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationPartitionID]) == errSecSuccess);
        CFArrayRef list = (__bridge CFArrayRef)@[(__bridge id)sign, (__bridge id)partition];
        assert(strcmp(inspectACLs(list), "AUTHORIZED") == 0);
        assert(strcmp(inspectACLs((__bridge CFArrayRef)@[(__bridge id)sign]), "PARTITION_AUTHORIZATION_REQUIRED") == 0);
        assert(SecACLSetContents(sign, (__bridge CFArrayRef)@[(__bridge id)tool], CFSTR("sign"), kSecKeychainPromptRequirePassphase) == errSecSuccess);
        assert(strcmp(inspectACLs(list), "CODESIGN_AUTHORIZATION_REQUIRED") == 0);
        assert(SecACLSetContents(sign, NULL, CFSTR("sign"), 0) == errSecSuccess);
        assert(strcmp(inspectACLs(list), "CODESIGN_AUTHORIZATION_REQUIRED") == 0);
        assert(SecACLSetContents(sign, (__bridge CFArrayRef)@[(__bridge id)tool], CFSTR("sign"), 0) == errSecSuccess);
        assert(SecACLSetContents(partition, (__bridge CFArrayRef)@[], CFSTR("malformed"), 0) == errSecSuccess);
        assert(strcmp(inspectACLs(list), "PARTITION_AUTHORIZATION_REQUIRED") == 0);
        CFRelease(sign); CFRelease(partition); CFRelease(access); CFRelease(tool);
        puts("PASS");
    }
}
