// Minimal Web Speech API surface.
//
// lib.dom ships SpeechRecognitionEvent but not SpeechRecognition itself, so a
// file holding a recogniser cannot type it. This declares only what the app
// touches, rather than adding a dependency for one interface.

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean
  readonly length: number
  [index: number]: { readonly transcript: string; readonly confidence: number }
}

interface SpeechRecognitionResultListLike {
  readonly length: number
  [index: number]: SpeechRecognitionResultLike
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultListLike
}

interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string
  readonly message: string
}

declare class SpeechRecognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror:  ((e: SpeechRecognitionErrorEventLike) => void) | null
  onend:    ((e: Event) => void) | null
  onstart:  ((e: Event) => void) | null
}
