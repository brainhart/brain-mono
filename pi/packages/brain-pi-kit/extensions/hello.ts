/**
 * Minimal extension example with zero external imports.
 * This keeps local iteration simple in any pi installation.
 */
export default function (pi: any) {
  pi.registerCommand("brain-hello", {
    description: "Insert a starter coding prompt into the editor",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.setEditorText(
        [
          "Please help me implement this change safely:",
          "",
          "Context:",
          "- Goal:",
          "- Constraints:",
          "- Tests to run:",
        ].join("\n"),
      );
      ctx.ui.notify("Inserted starter prompt template into the editor.", "info");
    },
  });
}
