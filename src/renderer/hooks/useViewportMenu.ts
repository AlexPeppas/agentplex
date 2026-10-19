import { useLayoutEffect, type RefObject } from 'react';

/** Keep measured menus inside the window, including after resize or scrolling. */
export function useViewportMenu(
  menuRef: RefObject<HTMLDivElement | null>,
  position: { x: number; y: number } | null,
  anchorRef?: RefObject<HTMLDivElement | null>,
) {
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !position) return;
    const minWidth = getComputedStyle(menu).minWidth;
    const place = () => {
      const margin = 8;
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      menu.style.position = 'fixed';
      menu.style.margin = '0';
      menu.style.minWidth = `min(${minWidth}, ${Math.max(0, width - margin * 2)}px)`;
      menu.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
      menu.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
      menu.style.overflowY = 'auto';
      const rect = menu.getBoundingClientRect();
      const anchor = anchorRef?.current?.getBoundingClientRect();
      const x = anchor ? (anchor.right + rect.width <= width - margin ? anchor.right : anchor.left - rect.width) : position.x;
      const y = anchor?.top ?? position.y;
      menu.style.left = `${Math.max(margin, Math.min(x, width - rect.width - margin))}px`;
      menu.style.top = `${Math.max(margin, Math.min(y, height - rect.height - margin))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [menuRef, position, anchorRef]);
}
