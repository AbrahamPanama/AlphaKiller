const packageJson = require("./package.json");

const signingEnvironment = ["CSC_LINK", "CSC_KEY_PASSWORD"];
const apiKeyEnvironment = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];
const appleIdEnvironment = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];

const missingSigningEnvironment = missingEnvironmentVariables(signingEnvironment);
const hasApiKeyCredentials = missingEnvironmentVariables(apiKeyEnvironment).length === 0;
const hasAppleIdCredentials = missingEnvironmentVariables(appleIdEnvironment).length === 0;

if (missingSigningEnvironment.length > 0) {
  throw new Error(
    `macOS release signing requires: ${missingSigningEnvironment.join(", ")}`
  );
}

if (!hasApiKeyCredentials && !hasAppleIdCredentials) {
  throw new Error(
    "macOS release notarization requires either APPLE_API_KEY, APPLE_API_KEY_ID, and " +
      "APPLE_API_ISSUER or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID"
  );
}

// electron-builder checks Apple ID variables before API-key variables. Remove
// any complete or partial Apple ID set when the preferred API key is available.
if (hasApiKeyCredentials) {
  for (const name of appleIdEnvironment) {
    delete process.env[name];
  }
}

const {
  identity: _localIdentity,
  notarize: _localNotarize,
  forceCodeSigning: _localForceCodeSigning,
  ...releaseMacConfiguration
} = packageJson.build.mac;

module.exports = {
  ...packageJson.build,
  mac: {
    ...releaseMacConfiguration,
    forceCodeSigning: true,
    notarize: true
  }
};

function missingEnvironmentVariables(names) {
  return names.filter((name) => !process.env[name]?.trim());
}
