import Darwin
import Foundation
import Security

private let requestProfile = "pap-keychain-request/1"
private let responseProfile = "pap-keychain-response/1"
private let allowedService = "ai.provenance.evidence-vault"
private let runtimeIdentifier = "ai.provenance.consumer.runtime"
private let accessGroupSuffix = ".ai.provenance.evidence-vault"
private let maximumRequestBytes = 256 * 1024

private enum HelperFailure: Error { case rejected }

private func signingInformation(_ code: SecCode) throws -> [String: Any] {
  var staticCode: SecStaticCode?
  var value: CFDictionary?
  guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess, let staticCode,
        SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &value) == errSecSuccess,
        let information = value as? [String: Any] else { throw HelperFailure.rejected }
  return information
}

private func authorizeParentAndGetAccessGroup() throws -> String {
  var ownCode: SecCode?
  guard SecCodeCopySelf(SecCSFlags(), &ownCode) == errSecSuccess, let ownCode else { throw HelperFailure.rejected }
  let information = try signingInformation(ownCode)
  guard let team = information[kSecCodeInfoTeamIdentifier as String] as? String,
        !team.isEmpty,
        let entitlements = information[kSecCodeInfoEntitlementsDict as String] as? [String: Any],
        let groups = entitlements["keychain-access-groups"] as? [String],
        let accessGroup = groups.first(where: { $0.hasSuffix(accessGroupSuffix) }) else { throw HelperFailure.rejected }

  var parentCode: SecCode?
  let attributes = [kSecGuestAttributePid as String: NSNumber(value: getppid())] as CFDictionary
  guard SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &parentCode) == errSecSuccess,
        let parentCode else { throw HelperFailure.rejected }
  let escapedTeam = team.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
  let requirementText = "anchor apple generic and certificate leaf[subject.OU] = \"\(escapedTeam)\" and identifier \"\(runtimeIdentifier)\""
  var requirement: SecRequirement?
  guard SecRequirementCreateWithString(requirementText as CFString, SecCSFlags(), &requirement) == errSecSuccess,
        let requirement,
        SecCodeCheckValidity(parentCode, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else {
    throw HelperFailure.rejected
  }
  return accessGroup
}

private func decodeBase64URL(_ value: String) -> Data? {
  guard value.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil else { return nil }
  var encoded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
  return Data(base64Encoded: encoded, options: [])
}

private func encodeBase64URL(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

private func respond(_ status: String, value: String? = nil) -> Never {
  var response: [String: Any] = ["profile": responseProfile, "status": status]
  if let value { response["value"] = value }
  let bytes = try! JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
  FileHandle.standardOutput.write(bytes)
  exit(EXIT_SUCCESS)
}

private func mappedResponse(_ status: OSStatus) -> Never {
  if status == errSecItemNotFound { respond("MISSING") }
  if status == errSecInteractionNotAllowed || status == errSecAuthFailed || status == errSecNotAvailable { respond("LOCKED") }
  respond("ERROR")
}

private func baseQuery(service: String, account: String, accessGroup: String) -> [String: Any] {
  [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecAttrAccessGroup as String: accessGroup,
    kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
    kSecUseDataProtectionKeychain as String: kCFBooleanTrue as Any,
  ]
}

do {
  let accessGroup = try authorizeParentAndGetAccessGroup()
  let input = FileHandle.standardInput.readDataToEndOfFile()
  guard !input.isEmpty, input.count <= maximumRequestBytes,
        let request = try JSONSerialization.jsonObject(with: input) as? [String: Any],
        request["profile"] as? String == requestProfile,
        let operation = request["operation"] as? String,
        let service = request["service"] as? String, service == allowedService,
        let account = request["account"] as? String,
        account.range(of: #"^vault:[A-Za-z0-9_-]{22}:(encryption:[A-Za-z0-9_-]{43}|signing:active)$"#, options: .regularExpression) != nil else {
    throw HelperFailure.rejected
  }
  let requiredKeys = operation == "set" ? Set(["profile", "operation", "service", "account", "value"])
                                         : Set(["profile", "operation", "service", "account"])
  guard Set(request.keys) == requiredKeys else { throw HelperFailure.rejected }
  let query = baseQuery(service: service, account: account, accessGroup: accessGroup)

  switch operation {
  case "get":
    var getQuery = query
    getQuery[kSecReturnData as String] = kCFBooleanTrue
    getQuery[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(getQuery as CFDictionary, &item)
    guard status == errSecSuccess, let secret = item as? Data else { mappedResponse(status) }
    respond("OK", value: encodeBase64URL(secret))
  case "set":
    guard let encoded = request["value"] as? String, let secret = decodeBase64URL(encoded),
          !secret.isEmpty, secret.count <= 4096 else { throw HelperFailure.rejected }
    let updateStatus = SecItemUpdate(query as CFDictionary, [kSecValueData as String: secret] as CFDictionary)
    if updateStatus == errSecSuccess { respond("OK") }
    guard updateStatus == errSecItemNotFound else { mappedResponse(updateStatus) }
    var addQuery = query
    addQuery[kSecValueData as String] = secret
    addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
    if addStatus == errSecSuccess { respond("OK") }
    mappedResponse(addStatus)
  case "delete":
    let status = SecItemDelete(query as CFDictionary)
    if status == errSecSuccess || status == errSecItemNotFound { respond("OK") }
    mappedResponse(status)
  default:
    throw HelperFailure.rejected
  }
} catch {
  exit(EXIT_FAILURE)
}
