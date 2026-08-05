import type { FormEvent as ReactFormEvent } from "react";

declare global {
  namespace React {
    type FormEvent<T = Element> = ReactFormEvent<T>;
  }
}

export {};
