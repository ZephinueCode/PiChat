import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isVoiceTrainingIntent,
  voiceTrainingTurnPrompt,
} from "./training-context.ts";
import {
  collectVoiceTrainingStatus,
  PICHAT_PACKAGE_ROOT,
} from "./training-status.ts";

export function installVoiceTrainingExtension(pi: ExtensionAPI): void {
  let followupTurns = 0;

  pi.on("before_agent_start", (event) => {
    if (isVoiceTrainingIntent(event.prompt)) {
      followupTurns = 3;
    } else if (followupTurns > 0) {
      followupTurns -= 1;
    } else {
      return;
    }
    return {
      systemPrompt: event.systemPrompt + voiceTrainingTurnPrompt(PICHAT_PACKAGE_ROOT),
    };
  });

  pi.registerTool({
    name: "voice_training_status",
    label: "Voice Training Status",
    description: "Inspect the local PiChat custom-voice training environment without loading models or reading transcript contents. Reports pipeline documentation, Python dependencies, base models, prepared dataset stages, checkpoints, evaluations, and registered voices. Use before planning, resuming, debugging, evaluating, or registering a custom voice.",
    promptSnippet: "Inspect PiChat custom-voice training readiness and existing local artifacts",
    promptGuidelines: [
      "For custom PiChat voice training, debugging, checkpoint evaluation, or registration, load the pichat-voice-training skill and inspect voice_training_status before acting.",
    ],
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute() {
      try {
        const status = collectVoiceTrainingStatus();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
          details: status,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Voice training status failed: ${message}` }],
          details: { error: message },
          isError: true,
        };
      }
    },
  });
}
