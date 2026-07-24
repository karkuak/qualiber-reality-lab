/**
 * Adapter-side evidence translation (design v2 §10/§11.2, ERL2-FR-016).
 *
 * The canonical evidence envelope is Lab-owned and immutable. `translate` reads
 * it, writes a *new* translated tree, and returns a receipt draft that accounts
 * for every admitted entry exactly once as `mapped_exact`, `mapped_lossy` or
 * `unsupported`.
 *
 * The SDK refuses locally what the host also refuses: an omitted entry, a
 * duplicate, an unknown entry, a lossy or unsupported mapping without a reason,
 * or a mapping whose target lies outside the translated tree. An adapter cannot
 * delete an input under "domain compatibility" — the honest disposition for
 * something it cannot represent is `unsupported`, which is retained.
 */

import { CODES, Erl2Error } from "@erl2/contracts";

export type TranslationDisposition = "mapped_exact" | "mapped_lossy" | "unsupported";

export interface TranslationMappingDraft {
  readonly entry_id: string;
  readonly disposition: TranslationDisposition;
  /** Paths inside the translated tree, relative to the run output directory. */
  readonly target_paths: readonly string[];
  readonly loss_reason_code?: string;
}

export interface TranslationReceiptDraft {
  readonly translated_tree_prefix: string;
  readonly mappings: readonly TranslationMappingDraft[];
  readonly total_input_entries: number;
  readonly accounted_entries: number;
}

export interface CanonicalEnvelopeView {
  readonly entry_ids: readonly string[];
}

/**
 * Builds a total translation receipt draft, or refuses.
 *
 * `mappings` must cover `envelope.entry_ids` exactly: no omission, no
 * duplicate, no invented source entry.
 */
export function buildTranslationReceipt(
  envelope: CanonicalEnvelopeView,
  translatedTreePrefix: string,
  mappings: readonly TranslationMappingDraft[],
): TranslationReceiptDraft {
  const known = new Set(envelope.entry_ids);
  const seen = new Set<string>();

  for (const mapping of mappings) {
    if (!known.has(mapping.entry_id)) {
      throw new Erl2Error(
        CODES.TRANSLATION_UNKNOWN_ENTRY,
        `translation invents source entry ${mapping.entry_id}`,
      );
    }
    if (seen.has(mapping.entry_id)) {
      throw new Erl2Error(
        CODES.TRANSLATION_ENTRY_DUPLICATED,
        `entry ${mapping.entry_id} is accounted for more than once`,
      );
    }
    seen.add(mapping.entry_id);

    if (mapping.disposition === "mapped_exact") {
      if (mapping.loss_reason_code !== undefined) {
        throw new Erl2Error(
          CODES.SCHEMA_VALIDATION_FAILED,
          `exact mapping for ${mapping.entry_id} declares a loss reason`,
        );
      }
      if (mapping.target_paths.length === 0) {
        throw new Erl2Error(
          CODES.TRANSLATION_ENTRY_OMITTED,
          `exact mapping for ${mapping.entry_id} has no target`,
        );
      }
    } else if (mapping.loss_reason_code === undefined) {
      // A lossy or unsupported disposition without a reason is a deletion
      // wearing a compatibility label.
      throw new Erl2Error(
        CODES.SCHEMA_VALIDATION_FAILED,
        `${mapping.disposition} mapping for ${mapping.entry_id} states no reason`,
      );
    }

    for (const target of mapping.target_paths) {
      if (!target.startsWith(`${translatedTreePrefix}/`)) {
        throw new Erl2Error(
          CODES.TRANSLATION_ENVELOPE_REWRITTEN,
          `mapping target ${target} lies outside the translated tree`,
        );
      }
    }
  }

  const missing = envelope.entry_ids.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new Erl2Error(
      CODES.TRANSLATION_ENTRY_OMITTED,
      `translation omits ${String(missing.length)} entry/entries, starting with ${String(missing[0])}`,
    );
  }

  return {
    translated_tree_prefix: translatedTreePrefix,
    mappings: [...mappings],
    total_input_entries: envelope.entry_ids.length,
    accounted_entries: seen.size,
  };
}
