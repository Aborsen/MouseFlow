import type { Meta, StoryObj } from '@storybook/react-vite';
import { Info } from 'lucide-react';
import { Button } from '../Button';
import { IconButton } from '../IconButton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '.';

const meta = {
  title: 'Components/Tooltip',
  component: TooltipContent,
  tags: ['autodocs'],
  args: {
    children: 'Tooltip content',
    side: 'top',
    showArrow: true,
  },
  argTypes: {
    side: {
      control: 'select',
      options: ['top', 'right', 'bottom', 'left'],
    },
    ref: { control: false, table: { disable: true } },
  },
  decorators: [
    (Story) => (
      <TooltipProvider delayDuration={200}>
        <div className="grid min-h-32 place-items-center">
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
} satisfies Meta<typeof TooltipContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="secondary">Hover me</Button>
      </TooltipTrigger>
      <TooltipContent {...args} />
    </Tooltip>
  ),
};

export const OnIconButton: Story = {
  args: { children: 'More information' },
  render: (args) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconButton variant="tertiary" aria-label="More information">
          <Info />
        </IconButton>
      </TooltipTrigger>
      <TooltipContent {...args} />
    </Tooltip>
  ),
};

export const Sides: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-4">
      {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
        <Tooltip key={side}>
          <TooltipTrigger asChild>
            <Button variant="secondary">{side}</Button>
          </TooltipTrigger>
          <TooltipContent {...args} side={side}>
            Tooltip on {side}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  ),
};
