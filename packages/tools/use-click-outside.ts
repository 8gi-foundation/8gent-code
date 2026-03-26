import React, { useEffect, RefObject } from 'react';

/**
 * Attaches event listeners to detect clicks or touches outside the referenced element.
 * @param ref - React ref object pointing to the element to monitor.
 * @param handler - Callback function to execute when a click or touch occurs outside the element.
 */
function useClickOutside(ref: RefObject<HTMLElement>, handler: (event: React.MouseEvent | React.TouchEvent) => void): void {
  useEffect(() => {
    const handleClick = (event: React.MouseEvent | React.TouchEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        handler(event);
      }
    };

    document.addEventListener('click', handleClick);
    document.addEventListener('touchstart', handleClick);

    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('touchstart', handleClick);
    };
  }, [ref, handler]);
}

export { useClickOutside };