import path from "node:path";

const VOICE_TERMS = /(?:pichat|qwen3?-?tts|tts|custom[ -]?voice|speaker|voice|speech|声音|音色|语音|说话人)/i;
const TRAINING_TERMS = /(?:train|fine[ -]?tun|dataset|checkpoint|epoch|codec|loss|converg|resume|evaluat|register|model|clone|build|create|训练|微调|数据集|检查点|轮次|损失|收敛|评估|注册|基座|模型|克隆|复刻|制作|创建|专属|做(?:一|个))/i;

export function isVoiceTrainingIntent(prompt: string): boolean {
  if (/\/skill:pichat-voice-training\b/i.test(prompt)) return true;
  return VOICE_TERMS.test(prompt) && TRAINING_TERMS.test(prompt);
}

export function voiceTrainingTurnPrompt(packageRoot: string): string {
  const skillPath = path.join(
    packageRoot,
    "skills",
    "pichat-voice-training",
    "SKILL.md",
  ).replace(/\\/g, "/");
  return `

<pichat_voice_training>
This turn concerns PiChat custom-voice training. Before answering, use the read tool to load ${JSON.stringify(skillPath)} and call voice_training_status when those tools are available. Base advice on the loaded workflow and reported local state. Do not start a mutating or long-running stage unless the user authorized it.
</pichat_voice_training>`;
}
