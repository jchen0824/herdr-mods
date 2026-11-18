// gcloud (GKE) sign-in: kept separate from AWS so a change to one can't quietly break the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as K from "../mods/kube/kube.js";
import { GCLOUD, AWS, OTHER, GKE_USER } from "./signin-fixtures.mjs";

const gke = K.authOf(GKE_USER);

test("a GKE kubeconfig user signs in with gcloud", () => {
  assert.deepEqual(gke, { provider: "gcloud", adc: false });
  assert.deepEqual(K.authOf({ ...GKE_USER, args: ["--use_application_default_credentials"] }), { provider: "gcloud", adc: true });
  assert.equal(K.authOf({ command: "/opt/google-cloud-sdk/bin/gke-gcloud-auth-plugin" }).provider, "gcloud");
});

test("an expired gcloud sign-in offers gcloud auth login", () => {
  const e = new K.KubeError(GCLOUD.reauth);
  assert.ok(e.auth && e.gcloud && !e.aws && !e.plugin);
  assert.deepEqual(K.signInFor(e, gke), { provider: "gcloud", title: "Your gcloud sign-in has expired", argv: ["gcloud", "auth", "login"] });
});

test("no active gcloud account offers gcloud auth login", () => {
  const s = K.signInFor(new K.KubeError(GCLOUD.noAccount), gke);
  assert.equal(s.title, "You're not signed in to gcloud");
  assert.deepEqual(s.argv, ["gcloud", "auth", "login"]);
});

test("application default credentials offer gcloud auth application-default login", () => {
  const fromText = K.signInFor(new K.KubeError(GCLOUD.adc), gke);
  assert.deepEqual(fromText.argv, ["gcloud", "auth", "application-default", "login"]);
  const fromKubeconfig = K.signInFor(new K.KubeError(GCLOUD.reauth), { provider: "gcloud", adc: true });
  assert.deepEqual(fromKubeconfig.argv, ["gcloud", "auth", "application-default", "login"]);
});

test("a gcloud error is still a gcloud sign-in when the kubeconfig auth is unknown", () => {
  assert.equal(K.signInFor(new K.KubeError(GCLOUD.reauth), null).provider, "gcloud");
});

test("AWS errors never offer a gcloud sign-in, even on a GKE context", () => {
  for (const [name, text] of Object.entries(AWS)) {
    const e = new K.KubeError(text);
    assert.ok(!e.gcloud, name);
    assert.notEqual(K.signInFor(e, null)?.provider, "gcloud", name);
  }
});

test("a missing plugin, the network or RBAC never offer a sign-in", () => {
  for (const [name, text] of Object.entries(OTHER)) assert.equal(K.signInFor(new K.KubeError(text), gke), null, name);
  assert.ok(new K.KubeError(OTHER.noGkePlugin).plugin);
});
