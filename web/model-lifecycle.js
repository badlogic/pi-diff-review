export function replaceDiffEditorModels(editor, current, factories) {
  let original = null;
  let modified = null;
  try {
    original = factories.createOriginal();
    modified = factories.createModified();
  } catch (error) {
    original?.dispose();
    modified?.dispose();
    throw error;
  }
  const next = { original, modified };

  editor.setModel(null);
  current.original?.dispose();
  current.modified?.dispose();
  try {
    editor.setModel(next);
  } catch (error) {
    original.dispose();
    modified.dispose();
    throw error;
  }

  return next;
}

export function detachDiffEditorModels(editor, current) {
  editor.setModel(null);
  current.original?.dispose();
  current.modified?.dispose();
  return { original: null, modified: null };
}
