import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';

/** The G2 canvas, in pixels. 4-bit greyscale, no colour. */
export const SCREEN = { width: 576, height: 288 } as const;

export type GlassesSession = {
  bridge: EvenAppBridge;
  /** Replace what the glasses show. */
  render(content: string): void;
  /** Called on a single tap of the temple touchpad (or the R1 ring's click). */
  onTap(handler: () => void): void;
  /** Tear down the page and stop listening. */
  close(): void;
};

/**
 * Resolve the Even App bridge, or `null` when there isn't one.
 *
 * `waitForEvenAppBridge()` listens for an `evenAppBridgeReady` event that only
 * the Even App's WebView ever fires — in a plain phone or desktop browser its
 * promise NEVER settles. Awaiting it directly at the top level of the entry
 * module would leave the installed PWA stuck on a blank page forever, so every
 * caller goes through this timeout race instead.
 */
export async function connectBridge(timeoutMs = 2500): Promise<EvenAppBridge | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([waitForEvenAppBridge(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Put one full-screen text container on the glasses and route its events, or
 * return `null` when there are no glasses to put it on.
 *
 * `connectBridge()` resolving is NOT proof of an Even App: the SDK installs a
 * bridge object on `window` in any browser, marks it ready after 100ms and
 * hands it over. Only the first call across it reveals whether a host is
 * listening — in a plain browser `createStartUpPageContainer` answers with a
 * non-zero code and the SDK logs "Flutter handler not available". That is the
 * ordinary standalone-PWA case, so it returns `null` rather than throwing.
 *
 * Event routing, the parts that are easy to get wrong:
 *   • Taps, double-taps and lifecycle events arrive on `event.sysEvent`;
 *     scroll gestures arrive on `event.textEvent`. Never mix the two.
 *   • Double-tap → `shutDownPageContainer` is checked at the root, before the
 *     tap branch and regardless of which envelope carried it, so the user can
 *     always leave the app.
 *   • CLICK_EVENT is 0 and protobuf omits zero-valued fields, so a single tap
 *     arrives with `eventType` undefined. The default has to be resolved
 *     INSIDE the envelope check — `event.sysEvent?.eventType ?? CLICK_EVENT`
 *     would read CLICK on events carrying no `sysEvent` at all, firing the tap
 *     handler for every scroll, exit and audio frame.
 */
export async function startGlassesPage(
  bridge: EvenAppBridge,
  initialContent: string,
): Promise<GlassesSession | null> {
  const container = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: SCREEN.width,
    height: SCREEN.height,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: 1,
    containerName: 'main',
    content: initialContent,
    isEventCapture: 1,
  });

  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [container] }),
  );
  if (result !== 0) {
    console.info(`[glasses] page container refused (${result}) — no Even App host, companion only`);
    return null;
  }

  const tapHandlers: Array<() => void> = [];

  function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
    if (!envelope) return null;
    return envelope.eventType ?? OsEventTypeList.CLICK_EVENT;
  }

  const unsubscribe = bridge.onEvenHubEvent((event) => {
    const sysType = eventTypeOf(event.sysEvent);
    const textType = eventTypeOf(event.textEvent);

    if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      bridge.shutDownPageContainer(1);
      return;
    }
    if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
      for (const handler of tapHandlers) handler();
      return;
    }
    if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      unsubscribe();
    }
  });

  return {
    bridge,
    render(content: string) {
      bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: 1, containerName: 'main', content }),
      );
    },
    onTap(handler: () => void) {
      tapHandlers.push(handler);
    },
    close() {
      unsubscribe();
      bridge.shutDownPageContainer(1);
    },
  };
}
