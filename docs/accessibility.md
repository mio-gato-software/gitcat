# Keyboard and VoiceOver walkthrough

Use a disposable repository; keep VoiceOver's caption panel open if recording findings.
On macOS enable VoiceOver with Command-F5. Turn on keyboard navigation in System Settings.

1. Tab to a project, then the branch list. Branch buttons announce pressed (selected)
   separately from current (the active branch). Selecting does not switch branches.
2. Use Shift-F10 on a branch or graph row to open its actions. Arrow through the menu,
   press Escape, and verify focus returns to the original control. Switch has a named button.
3. Tab through file inclusion checkboxes, open a diff, and navigate its text with VoiceOver.
   Open save review; confirm the project, selected files, local effects and remote effects.
4. Open Settings, identity, branch name, project setup, file/commit review, plan confirmation,
   AI sharing, and both conflict dialogs. In each, verify its title is spoken, initial focus
   is inside, Tab/Shift-Tab wrap, and the background is absent from VoiceOver navigation.
   Escape closes only the top dialog and focus returns to its opener. In AI sharing open
   a flagged file, close that review, and verify sharing remains open and focused.
5. Resolve a disposable conflict using the named version choices and keyboard confirmation.
   Errors should be announced without moving focus or losing drafts. Notifications announce
   changes politely; assistant errors use alerts.
6. At 1280x800 and 150% zoom, reach primary actions by Tab and scroll. Repeat at 200%.
   No dialog may trap its actions outside the viewport. Enable Reduce Motion: spinners
   and transitions stop while their text continues explaining activity. Verify visible
   focus against graphite surfaces; muted text uses the higher-contrast theme token.

Automated coverage: `npm run test:ui` checks keyboard context actions and focus return,
modal containment in both directions, background inertness, and Settings actions at
150% zoom on 1280x800. Existing graph, pane, selected-save and conflict checks remain.
Human VoiceOver listening is a manual check; automated DOM assertions do not prove
spoken output or substitute for observed usability sessions (#111).
