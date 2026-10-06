import { useEffect, useRef, useState } from 'react';
import lottie from 'lottie-web';
import { Bot } from 'lucide-react';
import animationData from '../assets/plex-contact-blob.json';

export function PlexMascot({ compact = false }: { compact?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!container.current) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const animation = lottie.loadAnimation({
      container: container.current, renderer: 'svg', loop: true, autoplay: false,
      animationData: structuredClone(animationData),
      rendererSettings: { progressiveLoad: false, preserveAspectRatio: 'xMidYMid meet' },
    });
    const updatePlayback = () => {
      if (motion.matches) animation.goToAndStop(0, true);
      else if (document.hidden) animation.pause();
      else animation.play();
    };
    const onError = () => {
      console.error('[plex] Welcome animation could not be rendered');
      animation.stop();
      setFailed(true);
    };
    animation.addEventListener('DOMLoaded', updatePlayback);
    animation.addEventListener('data_failed', onError);
    animation.addEventListener('error', onError);
    motion.addEventListener('change', updatePlayback);
    document.addEventListener('visibilitychange', updatePlayback);
    updatePlayback();
    return () => {
      motion.removeEventListener('change', updatePlayback);
      document.removeEventListener('visibilitychange', updatePlayback);
      animation.destroy();
    };
  }, []);
  return <div aria-hidden="true" data-plex-mascot={compact ? 'compact' : 'welcome'}
    className={compact ? 'w-10 h-10 shrink-0' : 'w-40 h-40 mx-auto'}>
    <div ref={container} className={failed ? 'hidden' : 'w-full h-full'} />
    {failed && <Bot className="w-full h-full text-accent" />}
  </div>;
}
