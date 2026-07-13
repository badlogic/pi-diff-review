export function createCommentEditorSavePolicy(flush) {
  let suppressNextBlur = false;

  return {
    beforeAction() {
      suppressNextBlur = true;
    },
    onBlur({ movingToCommentAction }) {
      if (suppressNextBlur) {
        suppressNextBlur = false;
        return;
      }
      if (!movingToCommentAction) flush();
    },
  };
}
