import { processText } from '../../../shared/textTools'
import type { TextRequest } from '../../../shared/toolbox'
self.onmessage = (event: MessageEvent<TextRequest>) => {
  try { self.postMessage({ result: processText(event.data) }) }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
}
