/* "Start a recording", asked for from somewhere that does not own the recorder.
 *
 * The sidebar's New recording lives in the shell; the recorder lives in the Record view. Rather than lift
 * the recorder's state into the shell to satisfy one button - which would put a poller and an agent client
 * above every route that does not need them - the shell asks and the view answers.
 *
 * A one-shot request rather than an event stream: it is pressed, it is honoured once, it is forgotten. The
 * pending flag exists because the click can happen while the view is still mounting, and a request dropped
 * because it arrived a frame early is a button that works only the second time.
 */
type Listener = () => void;

const listeners = new Set<Listener>();
let pending = false;

export function startRecordingRequested() {
  if (listeners.size === 0) {
    pending = true;
    return;
  }
  for (const listener of listeners) listener();
}

export function onStartRecording(listener: Listener) {
  listeners.add(listener);
  if (pending) {
    pending = false;
    // After mount, so a view that subscribes during render is not asked to act mid-render.
    setTimeout(listener, 0);
  }
  return () => {
    listeners.delete(listener);
  };
}
