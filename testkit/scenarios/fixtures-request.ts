/**
 * Build a `from`-protocol request body from a request fixture.
 *
 * The URL origin/path is the caller's concern (runner knows the source
 * protocol); this module only loads the fixture and honors stream mode.
 */
import { readFixture } from "../fixtures.js";

export interface FixtureRequestDoc {
  id: string;
  protocol: string;
  description?: string;
  source?: string;
  request: Record<string, unknown>;
}

export async function buildFixtureRequest(
  requestFile: string,
  streaming: boolean,
): Promise<{ id: string; body: Record<string, unknown> }> {
  const doc = await readFixture<FixtureRequestDoc>(requestFile);
  return { id: doc.id, body: { ...doc.request, stream: streaming } };
}
