import type { Meta, StoryObj } from '@storybook/react-vite';
import { Typography } from '../Typography';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '.';

// react-resizable-panels v4: the Group takes `orientation` ('horizontal' |
// 'vertical'); Panels take `defaultSize` / `minSize` (percentages).
const meta = {
  title: 'Components/Resizable',
  component: ResizablePanelGroup,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  args: {
    orientation: 'horizontal',
  },
  argTypes: {
    orientation: {
      control: 'select',
      options: ['horizontal', 'vertical'],
    },
    children: { control: false },
    className: { control: false },
  },
  decorators: [
    (Story) => (
      <div className="h-80 w-full rounded-md border border-stroke">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ResizablePanelGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

const PanelBody = ({ label }: { label: string }) => (
  <div className="flex h-full items-center justify-center p-4">
    <Typography variant="span" textColor="secondary">
      {label}
    </Typography>
  </div>
);

export const Horizontal: Story = {
  args: { orientation: 'horizontal' },
  render: (args) => (
    <ResizablePanelGroup {...args} orientation="horizontal">
      <ResizablePanel defaultSize={40} minSize={20}>
        <PanelBody label="Left" />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={60} minSize={20}>
        <PanelBody label="Right" />
      </ResizablePanel>
    </ResizablePanelGroup>
  ),
};

export const Vertical: Story = {
  args: { orientation: 'vertical' },
  render: (args) => (
    <ResizablePanelGroup {...args} orientation="vertical">
      <ResizablePanel defaultSize={50} minSize={15}>
        <PanelBody label="Top" />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={50} minSize={15}>
        <PanelBody label="Bottom" />
      </ResizablePanel>
    </ResizablePanelGroup>
  ),
};

export const ThreePanels: Story = {
  render: (args) => (
    <ResizablePanelGroup {...args} orientation="horizontal">
      <ResizablePanel defaultSize={25} minSize={15}>
        <PanelBody label="Sidebar" />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={50} minSize={20}>
        <PanelBody label="Editor" />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={25} minSize={15}>
        <PanelBody label="Preview" />
      </ResizablePanel>
    </ResizablePanelGroup>
  ),
};
