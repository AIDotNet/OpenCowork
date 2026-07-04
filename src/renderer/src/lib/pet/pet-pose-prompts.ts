export const PET_POSE_KEYS = [
  'idle',
  'walk',
  'sleep',
  'beg',
  'eat',
  'munch',
  'bathe',
  'soak',
  'swim',
  'zen',
  'play',
  'held'
] as const

export type PetPoseKey = (typeof PET_POSE_KEYS)[number]

const STYLE_SUFFIX =
  ' Simple flat 2D sticker style with soft cel shading and a clean thin dark outline, matching a kawaii sticker set. The exact same character design, colors and accessories in every image. True alpha-channel transparent background, no white die-cut border, no background pattern, no text, no ground shadow.'

const POSE_PROMPTS: Record<PetPoseKey, string> = {
  idle: 'full body, side profile view standing calmly, facing right, relaxed content expression.',
  walk: 'full body, side profile view walking to the right mid-stride, one front leg and the opposite hind leg lifted.',
  sleep:
    'full body, side view, lying down flat on its belly on the ground sleeping peacefully, eyes closed, legs tucked.',
  beg: 'full body, side view facing right, sitting up on its hind legs, front paws raised together begging for food, looking up with big pleading round eyes, mouth slightly open.',
  eat: 'full body, side profile view facing right, happily munching a fresh green leaf held in its mouth, cheeks puffed while chewing.',
  munch:
    'full body, side profile view facing right, happily eating a slice of red watermelon with green rind held in its front paws, cheeks puffed while chewing, eyes happy.',
  bathe:
    'sitting inside a small round wooden bathtub full of white foam bubbles, only its head and front paws visible above the foam, relaxed happy expression, a few bubbles floating around.',
  soak: 'relaxing inside a round wooden hot-spring bathtub, water up to its chest, a small orange mandarin fruit resting on top of its head, eyes closed in pure bliss, faint white steam wisps rising from the water.',
  swim: 'side profile view facing right, swimming leisurely in water, body half submerged with a gentle blue water ripple around it, front paws paddling, calm relaxed expression.',
  zen: 'full body, side view facing right, sitting upright completely still in a calm zen meditative pose, eyes half closed and serene, a tiny yellow bird perched on top of its head.',
  play: 'full body, side view facing right, jumping joyfully in mid-air with all four legs off the ground, happy open-mouth smile, sparkles of joy.',
  held: 'full body, front view, hanging in mid-air as if gently picked up by the scruff, hind legs dangling straight down, wide surprised round eyes.'
}

export function buildPetPosePrompt(pose: PetPoseKey, subject: string): string {
  const trimmed = subject.trim() || 'capybara'
  return `A cute chibi cartoon ${trimmed} mascot character, ${POSE_PROMPTS[pose]}${STYLE_SUFFIX}`
}

/**
 * Edit-style prompt used when the user supplies a reference image: the image
 * pins the character design, the prompt only changes the pose.
 */
export function buildPetPosePromptFromReference(pose: PetPoseKey, subject: string): string {
  const subjectNote = subject.trim() ? ` The character is: ${subject.trim()}.` : ''
  return `Keep the exact same character design, art style, colors and accessories as the reference image.${subjectNote} Change only the pose: the character is now shown ${POSE_PROMPTS[pose]} True alpha-channel transparent background, no white die-cut border, no background pattern, no text, no ground shadow.`
}
