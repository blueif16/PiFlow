import * as React from "react";

/* ============================================================
   ViewTransition — thin wrapper over React's experimental
   <ViewTransition> (activated by `experimental.viewTransition` in
   next.config). It isn't in the stable @types/react yet, so we read
   it off the runtime React namespace and type the props locally.
   Pairing two elements (gallery card ↔ detail hero) by the same
   `name` makes the App Router morph between them on navigation.
   If the runtime export is missing (flag off), it renders the child
   untouched — a safe no-op.
   ============================================================ */

type Props = {
  /** shared id — same name on both ends pairs them into a morph */
  name?: string;
  children: React.ReactElement;
};

const ReactViewTransition = (
  React as unknown as { ViewTransition?: React.ComponentType<Props> }
).ViewTransition;

export default function ViewTransition({ children, ...props }: Props) {
  if (!ReactViewTransition) return children;
  return <ReactViewTransition {...props}>{children}</ReactViewTransition>;
}
