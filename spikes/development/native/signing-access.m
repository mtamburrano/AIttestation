#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <CommonCrypto/CommonDigest.h>

static int report(const char *reason) {
    puts(reason);
    return strcmp(reason, "AUTHORIZED") == 0 ? 0 : 1;
}

static BOOL allowsCodesignPartition(NSString *description) {
    if (description.length == 0 || description.length > 32768 || description.length % 2) return NO;
    NSMutableData *data = [NSMutableData data];
    for (NSUInteger i = 0; i < description.length; i += 2) {
        NSString *pair = [description substringWithRange:NSMakeRange(i, 2)];
        if ([pair rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:
            @"0123456789abcdefABCDEF"] invertedSet]].location != NSNotFound) return NO;
        unsigned value = 0;
        if (![[NSScanner scannerWithString:pair] scanHexInt:&value]) return NO;
        uint8_t byte = value; [data appendBytes:&byte length:1];
    }
    id plist = [NSPropertyListSerialization propertyListWithData:data options:0 format:NULL error:NULL];
    if (![plist isKindOfClass:[NSDictionary class]]) return NO;
    id partitions = plist[@"Partitions"];
    return [partitions isKindOfClass:[NSArray class]] &&
        ([partitions containsObject:@"apple:"] || [partitions containsObject:@"apple-tool:"]);
}

static const char *inspectACLs(CFArrayRef list) {
    BOOL signingAllowed = NO, partitionFound = NO, partitionAllowed = YES;
    const char *failure = NULL;
    for (id entry in (__bridge NSArray *)list) {
        SecACLRef acl = (__bridge SecACLRef)entry;
        NSArray *tags = CFBridgingRelease(SecACLCopyAuthorizations(acl));
        BOOL signing = [tags containsObject:(__bridge id)kSecACLAuthorizationSign] ||
            [tags containsObject:(__bridge id)kSecACLAuthorizationAny];
        BOOL partition = [tags containsObject:(__bridge id)kSecACLAuthorizationPartitionID];
        if (!signing && !partition) continue;
        CFArrayRef applications = NULL; CFStringRef description = NULL;
        SecKeychainPromptSelector selector = 0;
        OSStatus status = SecACLCopyContents(acl, &applications, &description, &selector);
        if (status != errSecSuccess) { failure = "ACCESS_UNAVAILABLE"; break; }
        if (partition) {
            partitionFound = YES;
            partitionAllowed &= allowsCodesignPartition((__bridge NSString *)description);
        }
        // An explicit trusted-tool entry is required; an allow-all ACL is not
        // treated as the scoped owner authorization documented for this build.
        if (signing && !(selector & kSecKeychainPromptRequirePassphase)) {
            for (id application in (__bridge NSArray *)applications) {
                CFDataRef data = NULL;
                if (SecTrustedApplicationCopyData((__bridge SecTrustedApplicationRef)application, &data) == errSecSuccess) {
                    const char path[] = "/usr/bin/codesign";
                    signingAllowed |= CFDataGetLength(data) == sizeof(path) &&
                        memcmp(CFDataGetBytePtr(data), path, sizeof(path)) == 0;
                    CFRelease(data);
                }
            }
        }
        if (applications) CFRelease(applications);
        if (description) CFRelease(description);
    }
    if (failure) return failure;
    if (!signingAllowed) return "CODESIGN_AUTHORIZATION_REQUIRED";
    if (!partitionFound || !partitionAllowed) return "PARTITION_AUTHORIZATION_REQUIRED";
    return "AUTHORIZED";
}

static const char *inspectAccess(SecKeyRef key) {
    SecAccessRef access = NULL;
    if (SecKeychainItemCopyAccess((SecKeychainItemRef)key, &access) != errSecSuccess) return "ACCESS_UNAVAILABLE";
    CFArrayRef list = NULL;
    OSStatus status = SecAccessCopyACLList(access, &list); CFRelease(access);
    if (status != errSecSuccess || !list) return "ACCESS_UNAVAILABLE";
    const char *result = inspectACLs(list); CFRelease(list); return result;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3 || strlen(argv[1]) != 40 || argv[2][0] != '/') return report("INVALID_SELECTION");
        // This process only reads metadata from the explicitly selected file
        // Keychain. It never unlocks, imports, signs, or writes an ACL.
        if (SecKeychainSetUserInteractionAllowed(false) != errSecSuccess) return report("INTERACTION_GUARD_UNAVAILABLE");
        SecKeychainRef keychain = NULL;
        if (SecKeychainOpen(argv[2], &keychain) != errSecSuccess) return report("KEYCHAIN_UNAVAILABLE");
        SecKeychainStatus keychainStatus = 0;
        OSStatus status = SecKeychainGetStatus(keychain, &keychainStatus);
        if (status != errSecSuccess) { CFRelease(keychain); return report("KEYCHAIN_UNAVAILABLE"); }
        if (!(keychainStatus & kSecUnlockStateStatus)) { CFRelease(keychain); return report("KEYCHAIN_LOCKED"); }
        NSDictionary *query = @{
            (__bridge id)kSecClass: (__bridge id)kSecClassIdentity,
            (__bridge id)kSecMatchSearchList: @[(__bridge id)keychain],
            (__bridge id)kSecReturnRef: @YES,
            (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitAll,
        };
        CFTypeRef matches = NULL;
        status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &matches);
        CFRelease(keychain);
        if (status != errSecSuccess || !matches) return report("IDENTITY_UNAVAILABLE");
        const char *result = "IDENTITY_UNAVAILABLE";
        NSUInteger count = 0;
        for (id item in (__bridge NSArray *)matches) {
            SecCertificateRef certificate = NULL;
            if (SecIdentityCopyCertificate((__bridge SecIdentityRef)item, &certificate) != errSecSuccess) continue;
            NSData *der = CFBridgingRelease(SecCertificateCopyData(certificate)); CFRelease(certificate);
            unsigned char digest[CC_SHA1_DIGEST_LENGTH]; CC_SHA1(der.bytes, (CC_LONG)der.length, digest);
            NSMutableString *hex = [NSMutableString string];
            for (NSUInteger i = 0; i < sizeof(digest); i++) [hex appendFormat:@"%02X", digest[i]];
            if (![hex isEqualToString:[NSString stringWithUTF8String:argv[1]]]) continue;
            count++;
            SecKeyRef key = NULL;
            if (SecIdentityCopyPrivateKey((__bridge SecIdentityRef)item, &key) != errSecSuccess) result = "IDENTITY_UNAVAILABLE";
            else { result = inspectAccess(key); CFRelease(key); }
        }
        CFRelease(matches);
        return report(count > 1 ? "IDENTITY_AMBIGUOUS" : result);
    }
}
