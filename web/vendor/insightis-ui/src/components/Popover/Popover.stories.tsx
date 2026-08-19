import type { Meta, StoryObj } from '@storybook/react-vite';
import { Settings2 } from 'lucide-react';
import { Button } from '../Button';
import { Typography } from '../Typography';
import { Popover, PopoverContent, PopoverTrigger } from '.';

const meta = {
  title: 'Components/Popover',
  // Target PopoverContent so its positioning props (side/align/offsets) drive
  // the controls panel. Radix portals the content to document.body.
  component: PopoverContent,
  tags: ['autodocs'],
  args: {
    align: 'center',
    sideOffset: 4,
  },
  argTypes: {
    side: {
      control: 'select',
      options: ['top', 'right', 'bottom', 'left'],
    },
    align: {
      control: 'select',
      options: ['start', 'center', 'end'],
    },
    sideOffset: { control: 'number' },
    children: { control: false },
    ref: { control: false, table: { disable: true } },
    asChild: { control: false, table: { disable: true } },
  },
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof PopoverContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="secondary" leftSlot={<Settings2 />}>
          Open popover
        </Button>
      </PopoverTrigger>
      <PopoverContent {...args}>
        <div className="flex flex-col gap-2">
          <Typography variant="span" weight="medium">
            Dimensions
          </Typography>
          <Typography variant="span" textColor="secondary" className="text-sm">
            Set the width and height for the selected layer.
          </Typography>
        </div>
      </PopoverContent>
    </Popover>
  ),
};

export const InitiallyOpen: Story = {
  render: (args) => (
    <Popover defaultOpen>
      <PopoverTrigger asChild>
        <Button variant="secondary">Open popover</Button>
      </PopoverTrigger>
      <PopoverContent {...args}>
        <div className="flex flex-col gap-2">
          <Typography variant="span" weight="medium">
            Rendered open
          </Typography>
          <Typography variant="span" textColor="secondary" className="text-sm">
            Shown open so the panel is visible without interaction.
          </Typography>
        </div>
      </PopoverContent>
    </Popover>
  ),
};

export const Sides: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-4">
      {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
        <Popover key={side}>
          <PopoverTrigger asChild>
            <Button variant="secondary">{side}</Button>
          </PopoverTrigger>
          <PopoverContent {...args} side={side} className="w-48">
            <Typography variant="span" className="text-sm">
              Popover on {side}
            </Typography>
          </PopoverContent>
        </Popover>
      ))}
    </div>
  ),
};
