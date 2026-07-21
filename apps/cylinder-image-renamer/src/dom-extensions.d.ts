export {};

declare global {
  interface HTMLElement {
    showModal(): void;
    close(): void;
  }
}
