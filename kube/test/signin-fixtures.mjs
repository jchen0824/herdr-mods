// Real sign-in error texts, as kubectl prints them, for both providers. Both test files use
// these, so each provider's tests also check the other provider's errors never match it.

// gke-gcloud-auth-plugin wraps gcloud's own message (cloud-provider-gcp,
// cmd/gke-gcloud-auth-plugin: "failure while executing %s, with args %v: %w (err: %s)").
const plugin = (gcloudErr) => `Unable to connect to the server: getting credentials: exec: executable gke-gcloud-auth-plugin failed with exit code 1\n\nF1118 12:00:00.000000 cred.go:166] print credential failed with error: failed to retrieve access token: failure while executing gcloud, with args [config config-helper --format=json]: exit status 1 (err: ${gcloudErr})`;
export const GCLOUD = {
  reauth: plugin("ERROR: (gcloud.config.config-helper) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.\nPlease run:\n\n  $ gcloud auth login\n\nto obtain new credentials."),
  noAccount: plugin("ERROR: (gcloud.config.config-helper) You do not currently have an active account selected.\nPlease run:\n\n  $ gcloud auth login\n\nto obtain new credentials."),
  adc: "getting credentials: exec: executable gke-gcloud-auth-plugin failed with exit code 1\n\nprint credential failed with error: failed to retrieve access token: google: could not find default credentials. See https://cloud.google.com/docs/authentication/external/set-up-adc for more information",
};

// botocore's messages, through `aws eks get-token`.
const exec = (awsErr) => `E1118 12:00:00.000000 memcache.go:265] couldn't get current server API group list: Get "https://ABC123.gr7.us-east-1.eks.amazonaws.com/api": getting credentials: exec: executable aws failed with exit code 255\n\n${awsErr}`;
export const AWS = {
  noToken: exec("Error loading SSO Token: Token for acme does not exist"),
  expired: exec("The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile."),
  refresh: exec("Error when retrieving token from sso: Token has expired and refresh failed"),
  noCreds: exec("Unable to locate credentials. You can configure credentials by running \"aws configure\"."),
  stsExpired: exec("An error occurred (ExpiredTokenException) when calling the GetCallerIdentity operation: The security token included in the request is expired"),
  noProfile: exec("The config profile (payments-admin) could not be found"),
};

// Neither: a missing helper binary, a network error, an RBAC refusal.
export const OTHER = {
  noGkePlugin: "getting credentials: exec: executable gke-gcloud-auth-plugin not found\n\nIt looks like you are trying to use a client-go credential plugin that is not installed.",
  noAwsCli: "getting credentials: exec: executable aws not found\n\nIt looks like you are trying to use a client-go credential plugin that is not installed.",
  network: "Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout",
  forbidden: "Error from server (Forbidden): pods is forbidden: User \"dev\" cannot list resource \"pods\" in API group \"\" at the cluster scope",
};

// What `gcloud container clusters get-credentials` and `aws eks update-kubeconfig` write.
export const GKE_USER = { apiVersion: "client.authentication.k8s.io/v1beta1", command: "gke-gcloud-auth-plugin", installHint: "Install gke-gcloud-auth-plugin for use with kubectl by following https://cloud.google.com/kubernetes-engine/docs/how-to/cluster-access-for-kubectl#install_plugin", provideClusterInfo: true };
export const EKS_USER = {
  apiVersion: "client.authentication.k8s.io/v1beta1", command: "aws",
  args: ["--region", "us-east-1", "eks", "get-token", "--cluster-name", "payments-eks", "--output", "json", "--role", "arn:aws:iam::123456789012:role/eks-admins"],
  env: [{ name: "AWS_PROFILE", value: "payments-admin" }],
};
