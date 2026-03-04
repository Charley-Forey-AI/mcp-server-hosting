const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const ssmClient = new SSMClient({ region: AWS_REGION });
const secretsClient = new SecretsManagerClient({ region: AWS_REGION });

async function resolveSecretRef(ref) {
  if (typeof ref !== "string" || !ref.trim()) {
    throw new Error("secret reference must be a non-empty string");
  }

  if (ref.startsWith("ssm://")) {
    const name = ref.replace("ssm://", "");
    const resp = await ssmClient.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    if (!resp.Parameter || typeof resp.Parameter.Value !== "string") {
      throw new Error(`ssm parameter '${name}' not found`);
    }
    return resp.Parameter.Value;
  }

  if (ref.startsWith("secretsmanager://")) {
    const raw = ref.replace("secretsmanager://", "");
    const [secretId, jsonKey] = raw.split("#");
    const resp = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
    const secretString = resp.SecretString || "";
    if (!jsonKey) return secretString;
    let parsed;
    try {
      parsed = JSON.parse(secretString);
    } catch (_error) {
      throw new Error(`secret '${secretId}' is not JSON, cannot read key '${jsonKey}'`);
    }
    const value = parsed[jsonKey];
    if (value === undefined || value === null) {
      throw new Error(`secret key '${jsonKey}' not found in '${secretId}'`);
    }
    return String(value);
  }

  throw new Error(`unsupported secret reference '${ref}'. Use ssm:// or secretsmanager://`);
}

async function resolveCommandEnvSecrets(commandEnvSecrets = {}) {
  const output = {};
  for (const [envKey, secretRef] of Object.entries(commandEnvSecrets)) {
    output[envKey] = await resolveSecretRef(secretRef);
  }
  return output;
}

module.exports = {
  resolveSecretRef,
  resolveCommandEnvSecrets,
};
