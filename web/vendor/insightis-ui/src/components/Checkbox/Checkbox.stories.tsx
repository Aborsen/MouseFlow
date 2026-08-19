import type { Meta, StoryObj } from '@storybook/react-vite';
import { Checkbox } from '.';

const meta = {
  title: 'Components/Checkbox',
  component: Checkbox,
  tags: ['autodocs'],
  args: {
    label: 'Accept terms and conditions',
    labelPosition: 'right',
    gap: 'md',
    disabled: false,
  },
  argTypes: {
    labelPosition: {
      control: 'select',
      options: ['left', 'right', 'top', 'bottom'],
    },
    gap: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
    checked: { control: false },
  },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithLabel: Story = {};

export const States: Story = {
  render: (args) => (
    <div className="flex flex-col gap-3">
      <Checkbox {...args} label="Unchecked" />
      <Checkbox {...args} defaultChecked label="Checked" />
      <Checkbox {...args} checked="indeterminate" label="Indeterminate" />
      <Checkbox {...args} disabled label="Disabled" />
      <Checkbox {...args} defaultChecked disabled label="Disabled checked" />
      <Checkbox {...args} aria-invalid defaultChecked label="Invalid" />
    </div>
  ),
};

export const WithoutLabel: Story = {
  args: { label: undefined, 'aria-label': 'Select row' },
};
