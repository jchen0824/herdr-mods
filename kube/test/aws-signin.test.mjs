// AWS sign-in: which profile a cluster uses, the profiles in ~/.aws/config, and which errors
// mean "sign in again". Formats are AWS's own: aws eks update-kubeconfig's exec entry, the
// config file from the CLI user guide, and botocore's error messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import * as K from "../mods/kube/kube.js";
import * as Demo from "../mods/kube/demo.js";
import { files } from "./herdr-stub.mjs";

// What `aws eks update-kubeconfig --name payments-eks --region us-east-1 --role-arn ...
// --profile payments-admin` writes (awscli/customizations/eks/update_kubeconfig.py).
const updateKubeconfig = {
  apiVersion: "client.authentication.k8s.io/v1beta1",
  command: "aws",
  args: ["--region", "us-east-1", "eks", "get-token", "--cluster-name", "payments-eks", "--output", "json",
    "--role", "arn:aws:iam::123456789012:role/eks-admins"],
  env: [{ name: "AWS_PROFILE", value: "payments-admin" }],
};

test("an EKS kubeconfig user names its AWS profile, region, role and cluster", () => {
  assert.deepEqual(K.authOf(updateKubeconfig), {
    provider: "aws", profile: "payments-admin", region: "us-east-1",
    role: "arn:aws:iam::123456789012:role/eks-admins", cluster: "payments-eks",
  });
  // Without --profile the entry has no env: the default profile signs in.
  assert.equal(K.authOf({ ...updateKubeconfig, env: undefined }).profile, null);
  assert.equal(K.authOf({ command: "/usr/local/bin/aws-iam-authenticator", args: ["token", "-i", "c1", "--profile", "ops"] }).profile, "ops");
  assert.deepEqual(K.authOf({ command: "gke-gcloud-auth-plugin" }), { provider: "gcloud" });
  assert.equal(K.authOf(undefined), null);
});

test("~/.aws/config: SSO profiles, their session, legacy SSO and key profiles", () => {
  const ps = K.parseAwsConfig(Demo.AWS_CONFIG);
  assert.deepEqual(ps.map((p) => [p.name, p.sso, p.session]), [
    ["default", false, null], ["payments-admin", true, "acme"], ["payments-readonly", true, "acme"],
    ["sandbox", true, null], ["ci-bot", false, null],
  ]);
  const admin = ps.find((p) => p.name === "payments-admin");
  assert.equal(admin.startUrl, "https://acme.awsapps.com/start");
  assert.equal(admin.role, "AdministratorAccess");
  assert.equal(ps.find((p) => p.name === "sandbox").startUrl, "https://acme-sandbox.awsapps.com/start");
  // Comments and odd spacing.
  const c = K.parseAwsConfig("# top\n[ profile  dev ]  ; trailing\nsso_session=s1 # inline\n[sso-session s1]\nsso_start_url = https://x/start\n");
  assert.deepEqual(c.map((p) => [p.name, p.session, p.startUrl]), [["dev", "s1", "https://x/start"]]);
});

test("any text parses without throwing, and every profile has a name", () => {
  fc.assert(fc.property(fc.string({ unit: "binary", maxLength: 400 }), (text) => {
    for (const p of K.parseAwsConfig(text)) assert.equal(typeof p.name, "string");
  }));
});

test("awsProfiles reads ~/.aws/config only, and copes with none", async () => {
  delete files["/home/test/.aws/config"];
  assert.deepEqual(await K.awsProfiles("ctx"), []);
  files["/home/test/.aws/config"] = "[profile a]\nsso_session = s\n";
  assert.deepEqual((await K.awsProfiles("ctx")).map((p) => p.name), ["a"]);
  assert.equal((await K.awsProfiles("demo:x")).length, 5);
});

test("botocore's SSO and credential errors are sign-in errors", () => {
  const sso = [
    "getting credentials: exec: executable aws failed with exit code 255\n\nError loading SSO Token: Token for acme does not exist",
    "The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.",
    "Error when retrieving token from sso: Token has expired and refresh failed",
    "Unable to locate credentials. You can configure credentials by running \"aws configure\".",
    "An error occurred (ExpiredTokenException) when calling the GetCallerIdentity operation: The security token included in the request is expired",
  ];
  for (const text of sso) {
    const e = new K.KubeError(text);
    assert.ok(e.aws && e.auth && !e.plugin, text.slice(0, 60));
  }
  const missing = new K.KubeError("The config profile (payments-admin) could not be found");
  assert.ok(missing.aws && missing.profileMissing);
  // Not AWS: a gcloud expiry, a missing aws binary, a network error.
  assert.ok(!new K.KubeError("Reauthentication failed. Please run gcloud auth login").aws);
  const noCli = new K.KubeError("getting credentials: exec: executable aws not found");
  assert.ok(noCli.plugin && !noCli.aws && !noCli.auth);
  assert.ok(!new K.KubeError("dial tcp 10.0.0.1:443: i/o timeout").auth);
});

test("the demo EKS cluster fails with an SSO error and says which profile it uses", async () => {
  const { list } = Demo.contexts();
  const eks = list.find((c) => c.name.includes("eks"));
  assert.equal(eks.auth.profile, "payments-admin");
  await assert.rejects(K.kubectl(["get", "--raw", "/api/v1/pods"], { context: eks.name }), (e) => e.aws && e.auth);
});
