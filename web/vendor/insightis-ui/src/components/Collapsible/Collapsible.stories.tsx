import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../Button';
import { Typography } from '../Typography';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '.';

const meta = {
  title: 'Components/Collapsible',
  component: Collapsible,
  tags: ['autodocs'],
  args: {
    disabled: false,
  },
  argTypes: {
    open: { control: false },
    defaultOpen: { control: 'boolean' },
    disabled: { control: 'boolean' },
    onOpenChange: { control: false },
    children: { control: false },
  },
} satisfies Meta<typeof Collapsible>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  args: { defaultOpen: true },
  render: (args) => (
    <Collapsible {...args} className="flex w-80 flex-col gap-2">
      <div className="flex items-center justify-between">
        <Typography weight="medium">Advanced options</Typography>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" rightSlot={<ChevronDown />}>
            Toggle
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="flex flex-col gap-2 rounded-lg border border-stroke bg-surface-card p-3">
        <Typography textColor="secondary">Enable beta features</Typography>
        <Typography textColor="secondary">
          Share anonymous usage data
        </Typography>
        <Typography textColor="secondary">Show experimental UI</Typography>
      </CollapsibleContent>
    </Collapsible>
  ),
};

export const Interactive: Story = {
  render: (args) => {
    const [open, setOpen] = useState(false);
    return (
      <Collapsible
        {...args}
        open={open}
        onOpenChange={setOpen}
        className="flex w-80 flex-col gap-2"
      >
        <div className="flex items-center justify-between">
          <Typography weight="medium">
            {open ? 'Hide details' : 'Show details'}
          </Typography>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" rightSlot={<ChevronDown />}>
              Toggle
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="flex flex-col gap-2 rounded-lg border border-stroke bg-surface-card p-3">
          <Typography textColor="secondary">
            This panel is controlled with useState.
          </Typography>
          <Typography textColor="secondary">
            The open state is driven from the parent component.
          </Typography>
        </CollapsibleContent>
      </Collapsible>
    );
  },
};
