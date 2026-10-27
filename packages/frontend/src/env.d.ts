// Lets tsgo (which has no Vue SFC support) resolve `.vue` imports; vue-tsc
// type-checks the SFCs themselves with full template inference.
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent;
  export default component;
}
