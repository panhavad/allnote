import DMP from '/vendor/diff-match-patch.js';

const dmp = new DMP();
dmp.Match_Threshold = 0.4;
dmp.Patch_DeleteThreshold = 0.4;

// Three-way merge done entirely in the browser: re-apply "my" edits (base -> mine) on top of "theirs".
export function merge3(base, mine, theirs) {
  if (mine === base || mine === theirs) return theirs;
  if (theirs === base) return mine;
  const patches = dmp.patch_make(base, mine);
  const [merged] = dmp.patch_apply(patches, theirs);
  return merged;
}

// Map a caret offset from oldText into newText.
export function mapOffset(oldText, newText, offset) {
  if (oldText === newText) return offset;
  const diffs = dmp.diff_main(oldText, newText);
  return dmp.diff_xIndex(diffs, offset);
}
