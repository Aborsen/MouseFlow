import type { Meta, StoryObj } from '@storybook/react-vite';
import { Typography } from '../Typography';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '.';

const meta = {
  title: 'Components/Accordion',
  component: Accordion,
  tags: ['autodocs'],
  args: {
    // Only the shared (non-discriminant) props live in args. `type` is a
    // discriminated union on the Radix Root, so it's fixed per-story as a
    // literal (single vs multiple shown as separate stories below).
    orientation: 'vertical',
    disabled: false,
  },
  argTypes: {
    orientation: {
      control: 'select',
      options: ['vertical', 'horizontal'],
    },
    disabled: { control: 'boolean' },
    children: { control: false },
  },
} satisfies Meta<typeof Accordion>;

export default meta;
type Story = StoryObj<typeof meta>;

const items = [
  {
    value: 'billing',
    trigger: 'Billing',
    content: 'Manage your subscription, invoices, and payment methods here.',
  },
  {
    value: 'security',
    trigger: 'Security',
    content: 'Configure two-factor authentication and review active sessions.',
  },
  {
    value: 'notifications',
    trigger: 'Notifications',
    content: 'Choose which product updates and alerts you receive by email.',
  },
] as const;

const renderItems = () =>
  items.map((item) => (
    <AccordionItem key={item.value} value={item.value}>
      <AccordionTrigger>{item.trigger}</AccordionTrigger>
      <AccordionContent>
        <Typography>{item.content}</Typography>
      </AccordionContent>
    </AccordionItem>
  ));

export const SingleCollapsible: Story = {
  args: { type: 'single' },
  render: ({ orientation, disabled }) => (
    <Accordion
      type="single"
      collapsible
      defaultValue="billing"
      orientation={orientation}
      disabled={disabled}
    >
      {renderItems()}
    </Accordion>
  ),
};

export const Multiple: Story = {
  args: { type: 'multiple' },
  render: ({ orientation, disabled }) => (
    <Accordion
      type="multiple"
      defaultValue={['billing', 'security']}
      orientation={orientation}
      disabled={disabled}
    >
      {renderItems()}
    </Accordion>
  ),
};

export const Disabled: Story = {
  args: { type: 'single' },
  render: ({ orientation }) => (
    <Accordion type="single" collapsible disabled orientation={orientation}>
      {renderItems()}
    </Accordion>
  ),
};
