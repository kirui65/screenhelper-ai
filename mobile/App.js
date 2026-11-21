import React, { useEffect, useRef, useState } from "react";
import "react-native-url-polyfill/auto";
import {
  AppState,
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Linking from "expo-linking";
import { createClient } from "@supabase/supabase-js";
import {
  GoogleOneTapSignIn,
  GoogleSignInButton,
  isCancelledResponse,
  isNoSavedCredentialFoundResponse,
  isSuccessResponse,
} from "react-native-nitro-google-signin";
import ScreenStream from "./modules/screen-stream";

const API_URL = (process.env.EXPO_PUBLIC_API_URL || "").replace(/\/+$/, "");
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";
const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || "";
let configuredGoogleClientId = "";
function isSecureEndpoint(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || (__DEV__ && protocol === "http:");
  } catch {
    return false;
  }
}
const configured = Boolean(API_URL && SUPABASE_URL && SUPABASE_KEY && isSecureEndpoint(API_URL) && isSecureEndpoint(SUPABASE_URL));
const secureStorage = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};
const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { storage: secureStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false, flowType: "pkce" },
    })
  : null;

const palette = {
  bg: "#f5f8fb", ink: "#172b3b", muted: "#647586", line: "#dbe5ec",
  blue: "#0878bd", blueDark: "#05629d", white: "#ffffff", green: "#16845b",
};
const bundles = [
  { id: "pack_50", answers: 50, price: 25, label: "Starter" },
  { id: "pack_100", answers: 100, price: 50, label: "Small pack" },
  { id: "pack_250", answers: 250, price: 125, label: "Popular" },
  { id: "pack_500", answers: 500, price: 250, label: "Large pack" },
  { id: "pack_1000", answers: 1000, price: 500, label: "Value pack" },
];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, session, options = {}) {
  if (!isSecureEndpoint(API_URL)) throw new Error("Set the ScreenHelper API URL to an HTTPS endpoint before making requests.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        ...options.headers,
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "The request could not be completed.");
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The request took too long. Check your connection and try again.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function Button({ title, onPress, secondary = false, disabled = false, style }) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      activeOpacity={0.82}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, secondary && styles.buttonSecondary, disabled && styles.buttonDisabled, style]}
    >
      <Text style={[styles.buttonText, secondary && styles.buttonTextSecondary]}>{title}</Text>
    </TouchableOpacity>
  );
}

function AuthScreen({ passwordRecovery = false, recoveryMessage = "", onPasswordUpdated }) {
  const [mode, setMode] = useState(passwordRecovery ? "update-password" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(recoveryMessage);
  const [confirmationPending, setConfirmationPending] = useState(false);

  useEffect(() => {
    if (passwordRecovery) setMode("update-password");
  }, [passwordRecovery]);

  async function submit() {
    if (!supabase) return;
    setBusy(true);
    setMessage("");
    try {
      if (mode === "recovery") {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: Linking.createURL("auth/callback"),
        });
        if (error) throw error;
        setMessage("If an account exists for that address, a password reset link is on its way.");
      } else if (mode === "update-password") {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        onPasswordUpdated?.();
      } else {
        const result = mode === "login"
          ? await supabase.auth.signInWithPassword({ email: email.trim(), password })
          : await supabase.auth.signUp({
              email: email.trim(),
              password,
              options: { emailRedirectTo: Linking.createURL("auth/callback") },
            });
        if (result.error) throw result.error;
        const noLinkedEmailIdentity = mode === "signup" && result.data.user?.identities?.length === 0;
        if (noLinkedEmailIdentity) {
          setConfirmationPending(true);
          setMessage("An account already exists. Try signing in; if it still needs confirmation, resend the email below. Use Forgot your password for a reset link.");
        } else if (mode === "signup" && !result.data.session) {
          setConfirmationPending(true);
          setMessage("Check your inbox, spam, and promotions folders for the confirmation email. You can resend it below.");
        }
      }
    } catch (error) {
      setMessage(error.message || "Could not complete that request.");
    } finally {
      setBusy(false);
    }
  }

  async function resendConfirmation() {
    if (!supabase || !email.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: email.trim(),
        options: { emailRedirectTo: Linking.createURL("auth/callback") },
      });
      if (error) throw error;
      setMessage("If that account still needs confirmation, a new email has been sent. Check spam and promotions too.");
    } catch (error) {
      setMessage(error.message || "Could not resend the confirmation email.");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithGoogle() {
    if (!supabase) return;
    setBusy(true);
    setMessage("");
    try {
      if (!GOOGLE_WEB_CLIENT_ID) throw new Error("Google sign-in needs the Google Web client ID in the EAS environment.");
      if (configuredGoogleClientId !== GOOGLE_WEB_CLIENT_ID) {
        GoogleOneTapSignIn.configure({ webClientId: GOOGLE_WEB_CLIENT_ID });
        configuredGoogleClientId = GOOGLE_WEB_CLIENT_ID;
      }
      await GoogleOneTapSignIn.checkPlayServices();
      let result = await GoogleOneTapSignIn.signIn();
      if (isNoSavedCredentialFoundResponse(result)) result = await GoogleOneTapSignIn.createAccount();
      if (isNoSavedCredentialFoundResponse(result)) result = await GoogleOneTapSignIn.presentExplicitSignIn();
      if (isCancelledResponse(result)) {
        setMessage("Google stopped after account selection. The Android OAuth client must include this app's package name and EAS signing SHA-1.");
        return;
      }
      if (!isSuccessResponse(result) || !result.data.idToken) {
        throw new Error("Google sign-in did not return an ID token. Check the Android OAuth client and signing certificate.");
      }
      const { error } = await supabase.auth.signInWithIdToken({
        provider: "google",
        token: result.data.idToken,
      });
      if (error) throw error;
    } catch (error) {
      setMessage(error.message || "Could not sign in with Google.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.authPage} keyboardShouldPersistTaps="handled">
      <View style={styles.brandMark}><Text style={styles.brandMarkText}>S</Text></View>
      <Text style={styles.eyebrow}>SCREENHELPER AI</Text>
      <Text style={styles.title}>A clearer answer starts with your screen.</Text>
      <Text style={styles.subtitle}>Share another app in split screen, capture what you’re looking at, and get a careful explanation.</Text>
      <View style={styles.card}>
        {!configured && <Text style={styles.notice}>Set the mobile API URL and Supabase settings to HTTPS endpoints in mobile/.env before signing in.</Text>}
        <Text style={styles.cardTitle}>
          {mode === "login" ? "Welcome back" : mode === "signup" ? "Create your account" : mode === "recovery" ? "Reset your password" : "Choose a new password"}
        </Text>
        {mode !== "update-password" && <>
          <Text style={styles.label}>Email address</Text>
          <TextInput autoCapitalize="none" autoComplete="email" keyboardType="email-address" onChangeText={setEmail} placeholder="you@example.com" placeholderTextColor="#8998a6" style={styles.input} value={email} />
        </>}
        {mode !== "recovery" && <>
          <Text style={styles.label}>{mode === "update-password" ? "New password" : "Password"}</Text>
          <TextInput autoCapitalize="none" autoComplete={mode === "update-password" ? "new-password" : "password"} onChangeText={setPassword} placeholder="At least 8 characters" placeholderTextColor="#8998a6" secureTextEntry style={styles.input} value={password} />
        </>}
        {message ? <Text style={styles.message}>{message}</Text> : null}
        {confirmationPending && mode === "signup" && <TouchableOpacity disabled={busy} onPress={resendConfirmation} style={styles.modeToggle}>
          <Text style={styles.linkText}>{busy ? "Sending…" : "Resend confirmation email"}</Text>
        </TouchableOpacity>}
        <Button
          title={busy ? "Please wait…" : mode === "login" ? "Sign in" : mode === "signup" ? "Create account" : mode === "recovery" ? "Send reset link" : "Update password"}
          onPress={submit}
          disabled={!configured || busy || (mode !== "update-password" && !email) || (mode !== "recovery" && password.length < 8)}
        />
        {mode === "login" && <TouchableOpacity onPress={() => { setMode("recovery"); setMessage(""); }} style={styles.modeToggle}>
          <Text style={styles.linkText}>Forgot your password?</Text>
        </TouchableOpacity>}
        {(mode === "login" || mode === "signup") && <>
          <GoogleSignInButton
            accessibilityLabel="Continue with Google"
            size="wide"
            signInBehavior="none"
            onPress={signInWithGoogle}
            loading={busy}
            disabled={!configured || busy || !GOOGLE_WEB_CLIENT_ID}
            style={{ alignSelf: "center", marginTop: 12 }}
          />
          {!GOOGLE_WEB_CLIENT_ID && <Text style={styles.googleSetupMessage}>Google sign-in is not configured for this build.</Text>}
        </>}
        {(mode === "login" || mode === "signup") && <TouchableOpacity onPress={() => { setMode(mode === "login" ? "signup" : "login"); setMessage(""); }} style={styles.modeToggle}>
          <Text style={styles.linkText}>{mode === "login" ? "New to ScreenHelper? Create an account" : "Already have an account? Sign in"}</Text>
        </TouchableOpacity>}
        {(mode === "recovery" || mode === "update-password") && <TouchableOpacity onPress={() => { setMode("login"); setMessage(""); }} style={styles.modeToggle}>
          <Text style={styles.linkText}>Back to sign in</Text>
        </TouchableOpacity>}
      </View>
      <Text style={styles.footnote}>Android asks for permission before ScreenHelper shares your screen. A captured frame is sent only when you tap Get an answer.</Text>
    </ScrollView>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const [usage, setUsage] = useState(null);
  const [image, setImage] = useState(null);
  const [captureActive, setCaptureActive] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedBundle, setSelectedBundle] = useState(null);
  const [phone, setPhone] = useState("");
  const [paymentId, setPaymentId] = useState(null);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState("");
  const [showBundles, setShowBundles] = useState(false);
  const paymentActionInFlight = useRef(false);
  const answerActionInFlight = useRef(false);
  const { width: viewportWidth } = useWindowDimensions();
  const compact = viewportWidth < 430;

  useEffect(() => {
    if (!supabase) { setChecking(false); return undefined; }
    supabase.auth.getSession()
      .then(({ data }) => { setSession(data.session); setChecking(false); })
      .catch(() => { setError("Could not restore your secure sign-in. Please sign in again."); setChecking(false); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    async function handleAuthLink(url) {
      const params = Linking.parse(url).queryParams || {};
      const authType = typeof params.type === "string" ? params.type : "";
      if (authType === "recovery" && active) setPasswordRecovery(true);
      const code = typeof params.code === "string" ? params.code : "";
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error && active && authType === "recovery") setRecoveryMessage(error.message || "This reset link is invalid or has expired.");
        if (error && active && authType !== "recovery") setError(error.message || "This confirmation link is invalid or has expired.");
      }
    }
    Linking.getInitialURL().then((url) => { if (url) return handleAuthLink(url); }).catch(() => {});
    const subscription = Linking.addEventListener("url", ({ url }) => { void handleAuthLink(url); });
    return () => { active = false; subscription.remove(); };
  }, []);

  useEffect(() => {
    if (!supabase) return undefined;
    const refresh = (state) => {
      if (state === "active") supabase.auth.startAutoRefresh();
      else supabase.auth.stopAutoRefresh();
    };
    refresh(AppState.currentState);
    const listener = AppState.addEventListener("change", refresh);
    return () => {
      listener.remove();
      supabase.auth.stopAutoRefresh();
    };
  }, []);

  useEffect(() => {
    if (!session || !API_URL) { setUsage(null); return; }
    api("/api/me", session).then((data) => setUsage(data.usage || null)).catch((e) => setError(e.message));
  }, [session]);

  useEffect(() => {
    if (!session) return undefined;
    ScreenStream.isActive().then(setCaptureActive).catch(() => setCaptureActive(false));
    return undefined;
  }, [session]);

  useEffect(() => {
    if (!captureActive) return undefined;
    const timer = setInterval(() => {
      ScreenStream.isActive().then((active) => {
        setCaptureActive(active);
        if (!active) setImage(null);
      }).catch(() => setCaptureActive(false));
    }, 2000);
    return () => clearInterval(timer);
  }, [captureActive]);

  async function startScreenSharing() {
    setError("");
    try {
      await ScreenStream.start();
      let active = false;
      for (let attempt = 0; attempt < 20 && !active; attempt += 1) {
        await wait(250);
        active = await ScreenStream.isActive();
      }
      if (!active) throw new Error("Android permission was granted, but screen sharing did not start. Please try again.");
      setCaptureActive(true);
      setImage(null);
      setAnswer("");
    } catch (e) {
      setError(e.message || "Could not start Android screen sharing.");
    }
  }

  async function stopScreenSharing() {
    try { await ScreenStream.stop(); } catch { /* Android may already have stopped the projection. */ }
    setCaptureActive(false);
    setImage(null);
  }

  async function captureCurrentScreen() {
    setError("");
    try {
      const data = await ScreenStream.captureFrame();
      if (!data) throw new Error("No frame is ready yet. Wait a moment and try again.");
      setImage({ uri: data, data });
      setAnswer("");
    } catch (e) {
      setError(e.message || "Could not capture the shared screen.");
    }
  }

  async function ask() {
    if (answerActionInFlight.current || !session || !captureActive) return;
    if (typeof image?.data !== "string" || !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(image.data)) {
      setError("Capture a screen frame before asking a question.");
      return;
    }
    answerActionInFlight.current = true;
    setBusy(true); setError(""); setAnswer("");
    try {
      const data = await api("/api/ask", session, {
        method: "POST",
        body: JSON.stringify({
          image: image.data,
          prompt: prompt.trim()
            ? `Focus on the app being shared. Ignore ScreenHelper's own interface if it is also visible.\n\n${prompt.trim()}`
            : "Read the visible question or task in the app being shared. Ignore ScreenHelper's own interface if it is also visible.",
        }),
      });
      const answerText = typeof data.answer === "string" ? data.answer.trim() : "";
      if (!answerText) throw new Error("No answer came back. Please capture the screen again and retry.");
      setAnswer(answerText);
      setUsage(data.usage || null);
    } catch (e) {
      setError(e.message || "Could not get an answer.");
      if (e.message?.includes("free trial") || e.message?.includes("answer bundle")) {
        try { setUsage((await api("/api/me", session)).usage || null); } catch { /* Keep the original error visible. */ }
      }
    } finally {
      answerActionInFlight.current = false;
      setBusy(false);
    }
  }

  async function signOut() {
    await stopScreenSharing();
    await supabase?.auth.signOut();
    setImage(null); setAnswer(""); setUsage(null);
  }

  async function checkPayment(id, attempts = 1) {
    if (!id || !session || paymentActionInFlight.current) return;
    paymentActionInFlight.current = true;
    setPaymentBusy(true);
    setPaymentMessage(attempts > 1 ? "Waiting for M-Pesa confirmation…" : "Checking payment status…");
    try {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) await wait(5000);
        const status = await api(`/api/payments/${encodeURIComponent(id)}`, session);
        setUsage(status.usage || null);
        if (status.status === "paid") {
          setPaymentMessage("Payment received. Your answers have been added.");
          setPaymentId(null);
          return;
        }
        if (status.status === "failed") {
          setPaymentMessage("Payment failed or was cancelled. You can try again.");
          setPaymentId(null);
          return;
        }
      }
      setPaymentMessage("Payment is still pending. You can check again; your balance updates after Lipwa confirms it.");
    } catch (e) {
      setPaymentMessage(e.message || "Could not check payment status.");
    } finally {
      paymentActionInFlight.current = false;
      setPaymentBusy(false);
    }
  }

  async function startPayment() {
    if (!selectedBundle || !session || paymentActionInFlight.current) return;
    const normalizedPhone = phone.replace(/[\s()-]/g, "");
    if (!/^(?:\+?254|0)(?:7|1)\d{8}$/.test(normalizedPhone)) {
      setPaymentMessage("Enter a valid Kenyan M-Pesa number, such as 0712345678.");
      return;
    }
    paymentActionInFlight.current = true;
    setPaymentBusy(true);
    setPaymentMessage("Starting M-Pesa payment…");
    let pollId = null;
    try {
      const checkout = await api("/api/payments/checkout", session, {
        method: "POST",
        body: JSON.stringify({ phone: normalizedPhone, plan_id: selectedBundle.id }),
      });
      setPaymentId(checkout.payment_id);
      setPaymentMessage(`${checkout.message} Enter your M-Pesa PIN on your phone.`);
      pollId = checkout.payment_id;
    } catch (e) {
      setPaymentMessage(e.message || "Could not start payment.");
    } finally {
      paymentActionInFlight.current = false;
      if (!pollId) setPaymentBusy(false);
    }
    if (pollId) await checkPayment(pollId, 36);
  }

  if (checking) return <SafeAreaView style={styles.center}><ActivityIndicator color={palette.blue} size="large" /></SafeAreaView>;
  if (passwordRecovery) return <SafeAreaView style={styles.safe}><StatusBar barStyle="dark-content" backgroundColor={palette.bg} /><AuthScreen passwordRecovery recoveryMessage={recoveryMessage} onPasswordUpdated={() => { setPasswordRecovery(false); setRecoveryMessage(""); }} /></SafeAreaView>;
  if (!session) return <SafeAreaView style={styles.safe}><StatusBar barStyle="dark-content" backgroundColor={palette.bg} /><AuthScreen /></SafeAreaView>;

  const remaining = usage?.unlimited_access
    ? "Unlimited access"
    : usage?.trial_seconds_remaining > 0
      ? "Free trial active"
      : `${usage?.paid_answers ?? 0} answers remaining`;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={palette.bg} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={[styles.page, compact && styles.pageCompact]} keyboardShouldPersistTaps="handled">
          <View style={styles.topBar}>
            <View style={styles.topBarTitle}><Text style={styles.eyebrow}>SCREENHELPER AI</Text><Text style={[styles.screenTitle, compact && styles.screenTitleCompact]}>Ask about your screen</Text></View>
            <TouchableOpacity accessibilityRole="button" onPress={signOut}><Text style={styles.linkText}>Sign out</Text></TouchableOpacity>
          </View>
          <View style={styles.usage}><View style={styles.usageDot} /><Text style={styles.usageText}>{remaining}</Text></View>
          <View style={[styles.card, compact && styles.cardCompact]}>
            <Text style={styles.cardTitle}>Share another app</Text>
            <Text style={styles.cardCopy}>Start Android screen sharing and choose the app or display Android offers. ScreenHelper samples frames on this device; it sends a captured frame and your question to ScreenHelper and Coarena only when you tap Get an answer. Keep ScreenHelper beside the other app in split screen when supported.</Text>
            {captureActive ? <View style={styles.sharingStatus}><View style={styles.sharingDot} /><Text style={styles.sharingText}>Android screen sharing is active</Text></View> : null}
            {image ? <Image accessibilityLabel="Captured screen preview" source={{ uri: image.uri }} resizeMode="contain" style={[styles.preview, { height: Math.min(240, Math.max(100, viewportWidth * 0.55)) }]} /> : <View style={[styles.emptyPreview, { minHeight: Math.min(150, Math.max(90, viewportWidth * 0.34)) }]}><Text style={styles.emptyIcon}>▧</Text><Text style={styles.emptyText}>Captured screen preview appears here</Text></View>}
            <View style={[styles.buttonRow, compact && styles.buttonRowCompact]}>
              {captureActive
                ? <Button title="Stop sharing" onPress={stopScreenSharing} secondary style={[styles.halfButton, compact && styles.fullButton]} />
                : <Button title="Start screen sharing" onPress={startScreenSharing} style={[styles.halfButton, compact && styles.fullButton]} />}
              <Button title="Capture current screen" onPress={captureCurrentScreen} disabled={!captureActive} secondary style={[styles.halfButton, compact && styles.fullButton]} />
            </View>
          </View>
          <View style={[styles.card, compact && styles.cardCompact]}>
            <Text style={styles.cardTitle}>What would you like to know?</Text>
            <TextInput multiline onChangeText={setPrompt} placeholder="Ask a question about the shared screen…" placeholderTextColor="#8998a6" style={styles.prompt} textAlignVertical="top" value={prompt} />
            <Button title={busy ? "Reading your screen…" : "Get an answer"} onPress={ask} disabled={!image || !captureActive || busy || !API_URL} />
            {busy ? <ActivityIndicator color={palette.blue} style={styles.loader} /> : null}
          </View>
          {!usage?.unlimited_access ? <View style={[styles.card, compact && styles.cardCompact]}>
            <Text style={styles.cardTitle}>Answer bundles</Text>
            <Text style={styles.cardCopy}>Pay securely with M-Pesa. Credits are added only after the payment is confirmed.</Text>
            {paymentId ? <Button title="Check pending payment" secondary onPress={() => checkPayment(paymentId)} disabled={paymentBusy} style={styles.pendingButton} /> : null}
            <Button title={showBundles ? "Hide bundles" : "View answer bundles"} secondary onPress={() => setShowBundles(!showBundles)} style={styles.bundleToggle} />
            {showBundles ? bundles.map((bundle) => <View key={bundle.id} style={styles.bundleRow}>
              <View style={styles.bundleCopy}><Text style={styles.bundleName}>{bundle.label} · {bundle.answers.toLocaleString()} answers</Text><Text style={styles.bundlePrice}>KSh {bundle.price}</Text></View>
              <Button title="Choose" onPress={() => { setSelectedBundle(bundle); setPaymentMessage(""); }} style={styles.chooseButton} disabled={paymentBusy} />
            </View>) : null}
          </View> : null}
          {error ? <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View> : null}
          {answer ? <View style={[styles.card, compact && styles.cardCompact]}><Text style={styles.cardTitle}>Answer</Text><Text selectable style={styles.answer}>{answer}</Text></View> : null}
          <Text style={styles.privacy}>No audio is captured. Android may show blank content for apps that block screen capture. Stop sharing here or from Android’s screen-sharing controls.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
      <Modal animationType="slide" transparent visible={Boolean(selectedBundle)} onRequestClose={() => !paymentBusy && setSelectedBundle(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}><View><Text style={styles.eyebrow}>SECURE CHECKOUT</Text><Text style={styles.modalTitle}>Pay with M-Pesa</Text></View><TouchableOpacity accessibilityRole="button" onPress={() => setSelectedBundle(null)}><Text style={styles.modalClose}>×</Text></TouchableOpacity></View>
            {selectedBundle ? <Text style={styles.cardCopy}>{selectedBundle.answers.toLocaleString()} answers · KSh {selectedBundle.price}</Text> : null}
            <Text style={styles.label}>M-Pesa phone number</Text>
            <TextInput autoComplete="tel" keyboardType="phone-pad" onChangeText={setPhone} placeholder="0712345678" placeholderTextColor="#8998a6" style={styles.input} value={phone} />
            <Text style={styles.paymentHelp}>We’ll send a payment prompt to this number. Enter your M-Pesa PIN on your phone to confirm.</Text>
            {paymentMessage ? <Text accessibilityLiveRegion="polite" style={styles.paymentMessage}>{paymentMessage}</Text> : null}
            {paymentBusy ? <ActivityIndicator color={palette.blue} style={styles.loader} /> : null}
            <Button title={paymentBusy ? "Please wait…" : paymentId ? "Check payment status" : "Send M-Pesa prompt"} onPress={() => paymentId ? checkPayment(paymentId, 36) : startPayment()} disabled={paymentBusy} style={styles.modalAction} />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 }, safe: { flex: 1, backgroundColor: palette.bg }, center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: palette.bg },
  page: { padding: 20, paddingBottom: 36, maxWidth: 760, width: "100%", alignSelf: "center", gap: 14 }, pageCompact: { padding: 12, paddingBottom: 24, gap: 8 },
  authPage: { flexGrow: 1, justifyContent: "center", padding: 24, paddingBottom: 32, maxWidth: 620, width: "100%", alignSelf: "center" },
  brandMark: { width: 48, height: 48, borderRadius: 15, backgroundColor: palette.blue, alignItems: "center", justifyContent: "center", marginBottom: 18 }, brandMarkText: { color: palette.white, fontSize: 25, fontWeight: "800" },
  eyebrow: { color: palette.blue, fontSize: 11, fontWeight: "800", letterSpacing: 1.7, marginBottom: 5 }, title: { color: palette.ink, fontSize: 30, fontWeight: "800", letterSpacing: -0.8, lineHeight: 36, marginBottom: 9 }, subtitle: { color: palette.muted, fontSize: 15, lineHeight: 22, marginBottom: 22 },
  topBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12, paddingVertical: 4 }, topBarTitle: { flexShrink: 1 }, screenTitle: { color: palette.ink, fontSize: 22, fontWeight: "800", letterSpacing: -0.35 }, screenTitleCompact: { fontSize: 17 },
  card: { backgroundColor: palette.white, borderColor: palette.line, borderWidth: 1, borderRadius: 18, padding: 18, marginBottom: 14 }, cardCompact: { padding: 13, marginBottom: 7 }, cardTitle: { color: palette.ink, fontSize: 17, fontWeight: "750", marginBottom: 10 }, cardCopy: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: -4, marginBottom: 14 },
  label: { color: palette.ink, fontWeight: "650", fontSize: 13, marginBottom: 6, marginTop: 8 }, input: { borderColor: palette.line, borderWidth: 1, borderRadius: 11, paddingHorizontal: 13, paddingVertical: 12, color: palette.ink, fontSize: 15, backgroundColor: palette.white, marginBottom: 4 },
  button: { minHeight: 47, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 11, backgroundColor: palette.blue, alignItems: "center", justifyContent: "center" }, buttonSecondary: { backgroundColor: palette.white, borderWidth: 1, borderColor: palette.line }, buttonDisabled: { opacity: 0.52 }, buttonText: { color: palette.white, fontSize: 14, fontWeight: "750" }, buttonTextSecondary: { color: palette.ink },
  modeToggle: { paddingTop: 17, alignItems: "center" }, linkText: { color: palette.blue, fontSize: 13, fontWeight: "700" }, message: { color: palette.blueDark, fontSize: 13, lineHeight: 19, marginVertical: 10 }, googleSetupMessage: { color: palette.muted, fontSize: 12, lineHeight: 17, textAlign: "center", marginTop: 8 }, notice: { padding: 11, backgroundColor: "#fff6dd", borderRadius: 9, color: "#725313", fontSize: 12, lineHeight: 17, marginBottom: 14 }, footnote: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 17 },
  usage: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 99, backgroundColor: "#e7f5ee", gap: 8 }, usageDot: { width: 7, height: 7, backgroundColor: palette.green, borderRadius: 9 }, usageText: { color: "#166b4a", fontWeight: "700", fontSize: 12 },
  sharingStatus: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#e7f5ee", paddingHorizontal: 11, paddingVertical: 8, borderRadius: 9, alignSelf: "flex-start", marginBottom: 12 }, sharingDot: { width: 8, height: 8, borderRadius: 8, backgroundColor: palette.green }, sharingText: { color: "#166b4a", fontWeight: "700", fontSize: 12 },
  bundleRow: { minHeight: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, borderTopWidth: 1, borderTopColor: palette.line, paddingVertical: 8 }, bundleCopy: { flex: 1 }, bundleName: { color: palette.ink, fontWeight: "700", fontSize: 13 }, bundlePrice: { color: palette.muted, fontSize: 12, marginTop: 3 }, chooseButton: { minHeight: 38, paddingVertical: 8, paddingHorizontal: 14 }, pendingButton: { marginBottom: 10 }, bundleToggle: { marginTop: -4, marginBottom: 6 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(19, 35, 49, 0.48)", justifyContent: "flex-end" }, modalCard: { width: "100%", maxWidth: 620, alignSelf: "center", backgroundColor: palette.white, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 22, paddingBottom: 32 }, modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }, modalTitle: { color: palette.ink, fontSize: 22, fontWeight: "800" }, modalClose: { color: palette.muted, fontSize: 30, lineHeight: 32, paddingHorizontal: 6 }, paymentHelp: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 2, marginBottom: 6 }, paymentMessage: { color: palette.blueDark, fontSize: 13, lineHeight: 19, paddingVertical: 8 }, modalAction: { marginTop: 8 },
  emptyPreview: { minHeight: 150, borderWidth: 1, borderStyle: "dashed", borderColor: palette.line, backgroundColor: "#f7f9fb", borderRadius: 12, alignItems: "center", justifyContent: "center", marginBottom: 13, padding: 18 }, emptyIcon: { fontSize: 30, color: palette.blue, marginBottom: 5 }, emptyText: { color: palette.muted, fontSize: 13, textAlign: "center" }, preview: { width: "100%", height: 250, backgroundColor: "#edf2f6", borderRadius: 12, marginBottom: 13 }, buttonRow: { flexDirection: "row", gap: 9 }, buttonRowCompact: { flexDirection: "column" }, halfButton: { flex: 1 }, fullButton: { flex: 0, width: "100%" }, prompt: { minHeight: 96, maxHeight: 180, borderColor: palette.line, borderWidth: 1, borderRadius: 11, padding: 13, color: palette.ink, fontSize: 14, lineHeight: 20, marginBottom: 13 }, loader: { marginTop: 12 },
  errorBox: { padding: 14, borderRadius: 12, backgroundColor: "#fff0ef", borderColor: "#f3c7c2", borderWidth: 1 }, errorText: { color: "#a52e23", fontSize: 13, lineHeight: 19 }, answer: { color: palette.ink, fontSize: 15, lineHeight: 24 }, privacy: { color: palette.muted, fontSize: 11, lineHeight: 17, textAlign: "center", marginTop: 2 },
});
