// Cross-links in hosted editors always return to the office's overlay stack.
export function officeOverlayActions(open){
  return {
    openCard:id=>open('card',id),
    openItem:id=>open('item',id),
    openAgent:id=>open('agent',id),
    openQueue:id=>open('queue',id),
    openLink:url=>open('link',url),
  };
}
