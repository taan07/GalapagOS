"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { MAX_DICTATION_MS } from "../core/voice-dictation";

type RecognitionAlternativeLike = { transcript: string };
type RecognitionResultLike = {
  readonly isFinal: boolean;
  readonly 0: RecognitionAlternativeLike;
};
type RecognitionResultListLike = {
  readonly length: number;
  readonly [index: number]: RecognitionResultLike;
};
type RecognitionEventLike = Event & {
  readonly resultIndex: number;
  readonly results: RecognitionResultListLike;
};
type RecognitionErrorEventLike = Event & { readonly error: string };

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: RecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function microphoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Microphone access was denied. Allow it for localhost, then try again.";
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return "No microphone was found.";
    }
    if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      return "The microphone is already in use or unavailable.";
    }
  }
  return "The microphone could not be opened.";
}

function recognitionError(error: string): string | null {
  switch (error) {
    case "aborted":
    case "no-speech":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "Voice transcription permission was denied by the browser.";
    case "audio-capture":
      return "The browser lost access to the microphone.";
    case "network":
      return "Voice transcription lost its network connection; any captured text was kept.";
    case "language-not-supported":
      return "The browser does not support transcription for this language.";
    default:
      return `Voice transcription stopped (${error}).`;
  }
}

export type VoiceDictationStatus = "idle" | "requesting" | "recording" | "stopping";

export type VoiceDictationController = {
  status: VoiceDictationStatus;
  supported: boolean;
  elapsedMs: number;
  preview: string;
  error: string | null;
  waveformRef: RefObject<HTMLCanvasElement | null>;
  start(): Promise<void>;
  stop(): void;
  cancel(): void;
  clearError(): void;
};

/**
 * Browser dictation controller. GalapagOS never persists audio: getUserMedia
 * feeds only the live waveform, while the browser's speech recognizer returns
 * editable text. The media stream and AudioContext are torn down on every
 * success, error, cancellation, project switch, and unmount.
 */
export function useVoiceDictation(
  onTranscript: (transcript: string) => void,
): VoiceDictationController {
  const [status, setStatus] = useState<VoiceDictationStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(false);
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const limitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef(0);
  const generationRef = useRef(0);
  const activeRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const finalTranscriptRef = useRef("");
  const interimTranscriptRef = useRef("");
  const limitReachedRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    if (limitTimerRef.current) clearTimeout(limitTimerRef.current);
    if (finishTimerRef.current) clearTimeout(finishTimerRef.current);
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    elapsedTimerRef.current = null;
    limitTimerRef.current = null;
    finishTimerRef.current = null;
    restartTimerRef.current = null;
  }, []);

  const closeAudio = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    streamRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== "closed") {
      void context.close();
    }
  }, []);

  const finish = useCallback(
    (commit: boolean, failure?: string) => {
      if (!activeRef.current && !recognitionRef.current && !streamRef.current) {
        return;
      }
      activeRef.current = false;
      generationRef.current += 1;
      clearTimers();
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      if (recognition) {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        try {
          recognition.abort();
        } catch {
          // It may already have ended; cleanup remains authoritative.
        }
      }
      closeAudio();
      const transcript = `${finalTranscriptRef.current} ${interimTranscriptRef.current}`.trim();
      finalTranscriptRef.current = "";
      interimTranscriptRef.current = "";
      stopRequestedRef.current = false;
      setStatus("idle");
      setElapsedMs(0);
      setPreview("");
      const message =
        failure ??
        (limitReachedRef.current
          ? "Dictation stopped at the 10-minute safety limit; captured text was kept."
          : commit && !transcript
            ? "No speech was transcribed."
            : null);
      limitReachedRef.current = false;
      setError(message);
      if (commit && transcript) {
        onTranscriptRef.current(transcript);
      }
    },
    [clearTimers, closeAudio],
  );

  const drawWaveform = useCallback(() => {
    const canvas = waveformRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser || !activeRef.current) {
      return;
    }
    const width = Math.max(1, Math.floor(canvas.clientWidth));
    const height = Math.max(1, Math.floor(canvas.clientHeight));
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== width * scale || canvas.height !== height * scale) {
      canvas.width = width * scale;
      canvas.height = height * scale;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const samples = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(samples);
    const styles = getComputedStyle(canvas);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    context.beginPath();
    context.moveTo(0, height / 2);
    context.lineTo(width, height / 2);
    context.strokeStyle = styles.getPropertyValue("--line").trim() || "#263039";
    context.lineWidth = 1;
    context.stroke();
    context.beginPath();
    for (let index = 0; index < samples.length; index += 1) {
      const x = (index / (samples.length - 1)) * width;
      const amplitude = ((samples[index] ?? 128) - 128) / 128;
      const y = height / 2 + amplitude * height * 0.66;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = styles.getPropertyValue("--accent").trim() || "#7aa5c9";
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.stroke();
    animationFrameRef.current = requestAnimationFrame(drawWaveform);
  }, []);

  const stop = useCallback(() => {
    if (!activeRef.current || stopRequestedRef.current) return;
    stopRequestedRef.current = true;
    setStatus("stopping");
    try {
      recognitionRef.current?.stop();
    } catch {
      finish(true);
      return;
    }
    // Some browser implementations fail to emit onend after stop(). Never
    // leave the microphone UI or media track hanging on that implementation.
    finishTimerRef.current = setTimeout(() => finish(true), 1_500);
  }, [finish]);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    if (!activeRef.current && !recognitionRef.current && !streamRef.current) {
      setStatus("idle");
      return;
    }
    finish(false);
  }, [finish]);

  const clearError = useCallback(() => setError(null), []);

  const start = useCallback(async () => {
    if (activeRef.current || status !== "idle") return;
    const Recognition = recognitionConstructor();
    if (!Recognition) {
      setError("Voice dictation is not supported in this browser. Use current Chrome or Safari.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser cannot access a microphone from this page.");
      return;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    // Ref-level ownership closes the double-click window before React has
    // committed the requesting state.
    activeRef.current = true;
    setError(null);
    setPreview("");
    setElapsedMs(0);
    setStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (generationRef.current !== generation) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      // Own the stream immediately. If AudioContext or recognition setup
      // throws, the shared failure path can still close the microphone.
      streamRef.current = stream;
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
      if (generationRef.current !== generation) {
        closeAudio();
        return;
      }
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);

      const recognition = new Recognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";
      analyserRef.current = analyser;
      recognitionRef.current = recognition;
      finalTranscriptRef.current = "";
      interimTranscriptRef.current = "";
      stopRequestedRef.current = false;
      limitReachedRef.current = false;
      startedAtRef.current = performance.now();

      recognition.onresult = (event) => {
        let interim = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (!result) continue;
          const text = result?.[0]?.transcript?.trim();
          if (!text) continue;
          if (result.isFinal) {
            finalTranscriptRef.current = `${finalTranscriptRef.current} ${text}`.trim();
          } else {
            interim = `${interim} ${text}`.trim();
          }
        }
        interimTranscriptRef.current = interim;
        setPreview(`${finalTranscriptRef.current} ${interim}`.trim());
      };
      recognition.onerror = (event) => {
        const message = recognitionError(event.error);
        if (!message) return;
        finish(true, message);
      };
      recognition.onend = () => {
        if (!activeRef.current) return;
        if (stopRequestedRef.current) {
          finish(true);
          return;
        }
        // A recognizer can end at a silence boundary without upgrading its
        // last interim result. Preserve that text before starting a new
        // browser recognition segment.
        if (interimTranscriptRef.current) {
          finalTranscriptRef.current = `${finalTranscriptRef.current} ${interimTranscriptRef.current}`.trim();
          interimTranscriptRef.current = "";
          setPreview(finalTranscriptRef.current);
        }
        // Chrome can end a continuous recognizer after a silence boundary.
        // Keep the explicitly-started session alive without reopening the mic.
        restartTimerRef.current = setTimeout(() => {
          if (!activeRef.current || stopRequestedRef.current) return;
          try {
            recognition.start();
          } catch {
            finish(true, "Voice transcription could not resume; captured text was kept.");
          }
        }, 120);
      };

      recognition.start();
      setStatus("recording");
      animationFrameRef.current = requestAnimationFrame(drawWaveform);
      elapsedTimerRef.current = setInterval(
        () => setElapsedMs(performance.now() - startedAtRef.current),
        250,
      );
      limitTimerRef.current = setTimeout(() => {
        limitReachedRef.current = true;
        stop();
      }, MAX_DICTATION_MS);
    } catch (caught) {
      if (generationRef.current === generation) {
        finish(false, microphoneError(caught));
      }
    }
  }, [closeAudio, drawWaveform, finish, status, stop]);

  useEffect(() => {
    setSupported(recognitionConstructor() !== null);
  }, []);

  useEffect(() => {
    if (status === "idle") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, status]);

  useEffect(() => {
    const leave = () => cancel();
    const visibility = () => {
      if (document.visibilityState === "hidden") cancel();
    };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [cancel]);

  useEffect(() => cancel, [cancel]);

  return {
    status,
    supported,
    elapsedMs,
    preview,
    error,
    waveformRef,
    start,
    stop,
    cancel,
    clearError,
  };
}
