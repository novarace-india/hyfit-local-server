export type ColorKey = "R" | "G" | "B" | "Y";

export type ColorChoice = {
  key: ColorKey;
  label: string;
  color: string;
  textColor: string;
};

export const colorChoices: Record<ColorKey, ColorChoice> = {
  R: { key: "R", label: "Red", color: "#d51f1f", textColor: "#ffffff" },
  G: { key: "G", label: "Green", color: "#087c36", textColor: "#ffffff" },
  B: { key: "B", label: "Blue", color: "#1769d2", textColor: "#ffffff" },
  Y: { key: "Y", label: "Yellow", color: "#f2ca16", textColor: "#111111" },
};

export const cognitiveSequenceLength = 10;

export function validCognitiveSequence(value: unknown): value is ColorKey[] {
  if (!Array.isArray(value) || value.length !== cognitiveSequenceLength)
    return false;
  if (!value.every((color) => color in colorChoices)) return false;
  if (new Set(value).size !== Object.keys(colorChoices).length) return false;
  return !value.some(
    (color, index) =>
      index >= 2 && color === value[index - 1] && color === value[index - 2],
  );
}

/**
 * A fresh sequence for one race.
 *
 * Generated on the tablet because the race is: nothing about it is stored
 * server-side any more, so there is nowhere to have it assigned from. Rejection
 * sampling against the validator rather than a clever construction — the rules
 * (all four colours present, never three of the same in a row) are already
 * written there, and one function deciding what is valid is worth more than a
 * faster generator that could drift from it.
 */
export function generateCognitiveSequence(): ColorKey[] {
    const keys = Object.keys(colorChoices) as ColorKey[];
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const candidate = Array.from(
            { length: cognitiveSequenceLength },
            () => keys[Math.floor(Math.random() * keys.length)],
        );
        if (validCognitiveSequence(candidate)) return candidate;
    }
    // Deterministic fallback, so a race can always start. Cycling the four
    // colours satisfies every rule by construction.
    return Array.from(
        { length: cognitiveSequenceLength },
        (_, index) => keys[index % keys.length],
    );
}

export function scoreSequence(response: ColorKey[], sequence: ColorKey[]) {
  if (!validCognitiveSequence(sequence))
    return { correctCount: 0, percentage: 0 };
  const correctCount = response.filter(
    (value, index) => value === sequence[index],
  ).length;
  return {
    correctCount,
    percentage: Math.round((correctCount / sequence.length) * 100),
  };
}
