import { useState, useEffect } from 'react';

export function useCurrentTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') || 'dark';
  });

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const current = (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') || 'dark';
      setTheme(current);
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => observer.disconnect();
  }, []);

  return theme;
}
