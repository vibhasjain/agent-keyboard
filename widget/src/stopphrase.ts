// Mirrors AgentKeyboardIOS/Sources/Services/SpeechStopPhrase.swift — trailing
// "over and out" ends dictation and auto-sends. Keep the two patterns in sync.
const PATTERN = /(?:^|\s)over\s+and\s+out[\s.!?,;:]*$/i

export function contains(text: string): boolean {
  return PATTERN.test(text)
}

export function cleaned(text: string): string {
  return text.replace(PATTERN, '').trim()
}
