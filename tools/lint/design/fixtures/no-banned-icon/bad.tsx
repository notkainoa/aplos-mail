import { Sparkles } from 'lucide-react'; // @expect
import { Wand2, Brain } from 'lucide-react'; // @expect
import { Bot as Helper } from 'lucide-react'; // @expect
import { StarHalf } from 'lucide-react/icons'; // @expect
import { SparklesIcon } from './icons'; // @expect
import { Rocket, RobotHead } from '@phosphor-icons/react'; // @expect
import * as Icons from 'lucide-react';
import Star from 'lucide-react/dist/esm/icons/star'; // @expect

export function View() {
  return (
    <div>
      <Icons.Brain /> {/* @expect */}
      <Sparkles /> {/* @expect */}
      <span>✨</span> {/* @expect */}
      <span>Rated ★★★★☆</span> {/* @expect */}
      <Icon name="sparkle" /> {/* @expect */}
      <Icon name="wand.and.stars" /> {/* @expect */}
      <Icon symbol="apple.intelligence" /> {/* @expect */}
      <Icon symbol="brain.head.profile" /> {/* @expect */}
      <Icon name="star.fill" /> {/* @expect */}
      <Icon name="sparkles.rectangle.stack" /> {/* @expect */}
      <Icon name="wand.and.rays" /> {/* @expect */}
      <Icon name="star" /> {/* @expect */}
      <Icon name="brain" /> {/* @expect */}
      <button title="Smart reply 🤖" /> {/* @expect */}
      <i aria-label="&#9733;" /> {/* @expect */}
    </div>
  );
}

export const glyphs = ['🌟', '⭐', '🪄', '🧠']; // @expect
export const escaped = '✨ done'; // @expect
export const entity = '&#9733; starred'; // @expect

function Icon(props: { name?: string; symbol?: string }) {
  return <i {...props} />;
}

import { Sparkles as Ai } from './glyphs'; // @expect
export const dynamic = <DynamicIcon name="wand-sparkles" />; // @expect
export const dynamicToo = <DynamicIcon name="brain-circuit" />; // @expect
export const named = { icon: 'WandSparkles' }; // @expect
export const lone = { symbol: 'star' }; // @expect
export const several = ['star-off', 'bot-message-square']; // @expect
