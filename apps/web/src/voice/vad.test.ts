import { afterEach, describe, expect, it, vi } from "vitest";

// vad.ts is otherwise browser-only (it pulls in @ricky0123/vad-web -> onnxruntime).
// We mock the MicVAD seam so we can assert the mute/stop path FULLY releases the
// stream + AudioContext (destroy) rather than merely pausing the algorithm --
// otherwise the OS "mic in use" indicator stays lit while the user believes they
// are muted, a privacy/trust failure.

interface VadConfig {
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
}

const start = vi.fn(() => Promise.resolve());
const pause = vi.fn(() => Promise.resolve());
const destroy = vi.fn(() => Promise.resolve());
const micVadNew = vi.fn((_config: VadConfig) =>
  Promise.resolve({ start, pause, destroy }),
);

vi.mock("@ricky0123/vad-web", () => ({
  MicVAD: { new: (config: VadConfig) => micVadNew(config) },
}));

afterEach(() => {
  vi.clearAllMocks();
});

async function loadDetector() {
  const { SileroVadDetector } = await import("./vad");
  return new SileroVadDetector();
}

describe("SileroVadDetector teardown", () => {
  it("DESTROYS the VAD on stop (releases the stream), not just pause()", async () => {
    const vad = await loadDetector();
    await vad.start();
    expect(start).toHaveBeenCalledTimes(1);

    vad.stop();
    // The privacy-critical assertion: the stream/context are released via destroy,
    // and we do NOT leave it merely paused.
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it("rebuilds the graph on a start() after a stop()", async () => {
    const vad = await loadDetector();
    await vad.start();
    vad.stop();
    await vad.start();
    // A destroyed detector must be recreated (not reused), so MicVAD.new runs again.
    expect(micVadNew).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("preserves speech callbacks across a rebuild", async () => {
    const vad = await loadDetector();
    const starts: number[] = [];
    vad.onSpeechStart(() => starts.push(1));

    await vad.start();
    // Fire the onSpeechStart the real model would call, via the config passed to new.
    micVadNew.mock.calls[0]![0].onSpeechStart();
    vad.stop();
    await vad.start();
    micVadNew.mock.calls[1]![0].onSpeechStart();

    expect(starts).toEqual([1, 1]);
  });
});
