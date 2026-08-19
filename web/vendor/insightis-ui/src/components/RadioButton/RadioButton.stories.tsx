import type { Meta, StoryObj } from '@storybook/react-vite';
import { RadioButton, RadioGroup } from '.';

/**
 * `RadioButton` is a Radix radio item with an optional label and layout
 * controls. It must live inside a `RadioGroup` (Radix Root) to manage selection.
 * Use `value` on each button and `defaultValue`/`value` on the group.
 */
const meta = {
  title: 'Components/RadioButton',
  component: RadioButton,
  tags: ['autodocs'],
  args: {
    label: 'Option',
    value: 'option',
    variant: 'primary',
    size: 'md',
    labelPosition: 'right',
    gap: 'md',
    disabled: false,
  },
  argTypes: {
    variant: {
      control: 'select',
      options: ['primary'],
    },
    size: {
      control: 'select',
      options: ['md'],
    },
    labelPosition: {
      control: 'select',
      options: ['left', 'right', 'top', 'bottom'],
    },
    gap: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
    label: { control: 'text' },
    ref: { control: false, table: { disable: true } },
  },
} satisfies Meta<typeof RadioButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A single button must still be wrapped in a `RadioGroup`. */
export const Default: Story = {
  render: (args) => (
    <RadioGroup defaultValue="option">
      <RadioButton {...args} />
    </RadioGroup>
  ),
};

export const Group: Story = {
  render: (args) => (
    <RadioGroup defaultValue="banana">
      <RadioButton {...args} label="Apple" value="apple" />
      <RadioButton {...args} label="Banana" value="banana" />
      <RadioButton {...args} label="Cherry" value="cherry" />
    </RadioGroup>
  ),
};

export const Selected: Story = {
  args: { label: 'Selected', value: 'selected' },
  render: (args) => (
    <RadioGroup value="selected">
      <RadioButton {...args} />
    </RadioGroup>
  ),
};

export const Disabled: Story = {
  render: (args) => (
    <RadioGroup defaultValue="on">
      <RadioButton {...args} label="Disabled unchecked" value="off" disabled />
      <RadioButton {...args} label="Disabled checked" value="on" disabled />
    </RadioGroup>
  ),
};

export const LabelPositions: Story = {
  render: (args) => {
    const positions = ['right', 'left', 'top', 'bottom'] as const;
    return (
      <RadioGroup className="flex gap-6" defaultValue="right">
        {positions.map((labelPosition) => (
          <RadioButton
            {...args}
            key={labelPosition}
            label={labelPosition}
            value={labelPosition}
            labelPosition={labelPosition}
          />
        ))}
      </RadioGroup>
    );
  },
};
