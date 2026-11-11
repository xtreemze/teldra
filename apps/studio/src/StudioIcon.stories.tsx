import { For } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { StudioIcon, studioIconGroups } from "./StudioIcon";

const meta = {
  title: "Studio/Iconography",
  component: StudioIcon,
  args: { name: "isometric" },
} satisfies Meta<typeof StudioIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Library: Story = {
  render: () => (
    <div style={{"background":"#101821","color":"#e7edf4","padding":"1.5rem","font-family":"system-ui, sans-serif"}}>
      <h2 style={{"font-size":"1.1rem","margin":"0 0 1rem"}}>Teldra Studio · 24px outline language</h2>
      <p style={{"color":"#a8b5c4","font-size":".85rem"}}>1.8px rounded strokes · currentColor · semantic labels remain on controls</p>
      <For each={Object.entries(studioIconGroups)}>{([heading, names]) => (
        <section style={{"margin-top":"1.8rem"}}>
          <h3 style={{"font-size":".78rem","color":"#80e1cf","letter-spacing":".08em","text-transform":"uppercase"}}>{heading}</h3>
          <div style={{"display":"grid","grid-template-columns":"repeat(auto-fill, minmax(100px, 1fr))","gap":".6rem"}}>
            <For each={names}>{name => (
              <div style={{"min-height":"77px","border":"1px solid #354556","border-radius":".6rem","background":"#17212d","padding":".6rem","display":"grid","place-items":"center","gap":".35rem"}}>
                <StudioIcon name={name} size={26}/>
                <small style={{"color":"#b6cbd3","font-size":".7rem"}}>{name}</small>
              </div>
            )}</For>
          </div>
        </section>
      )}</For>
    </div>
  ),
};

export const ScaleAndContrast: Story = {
  render: () => (
    <div style={{"display":"flex","align-items":"center","gap":"2rem","padding":"2rem","background":"#17212d","color":"#80e1cf"}}>
      <For each={[16,20,24,32,48]}>{size => (
        <div style={{"display":"grid","gap":".75rem","place-items":"center","color":"#e7edf4"}}>
          <StudioIcon name="isometric" size={size}/>
          <small>{size}px</small>
        </div>
      )}</For>
    </div>
  ),
};
