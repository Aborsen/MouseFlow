import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../Button';
import { Typography } from '../Typography';
import {
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTrigger,
} from '.';

const meta = {
  title: 'Components/Modal',
  component: Modal,
  tags: ['autodocs'],
  parameters: {
    // Radix portals the dialog to document.body — snapshot the whole page.
    layout: 'centered',
  },
} satisfies Meta<typeof Modal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Modal>
      <ModalTrigger asChild>
        <Button variant="secondary">Open modal</Button>
      </ModalTrigger>
      <ModalContent>
        <ModalHeader>
          <ModalTitle>Rename chat</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <Typography textColor="body">
            Give this chat a short, descriptive name so it is easier to find
            later.
          </Typography>
        </ModalBody>
        <ModalFooter>
          <ModalClose asChild>
            <Button variant="secondary">Cancel</Button>
          </ModalClose>
          <Button>Save</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  ),
};

export const Destructive: Story = {
  render: () => (
    <Modal>
      <ModalTrigger asChild>
        <Button variant="destructiveOutline">Delete chat</Button>
      </ModalTrigger>
      <ModalContent>
        <ModalHeader>
          <ModalTitle>Delete chat?</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <Typography textColor="body">
            This action cannot be undone. The chat and all its messages will be
            permanently removed.
          </Typography>
        </ModalBody>
        <ModalFooter>
          <ModalClose asChild>
            <Button variant="secondary">Cancel</Button>
          </ModalClose>
          <Button variant="destructive">Delete</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  ),
};

export const InitiallyOpen: Story = {
  render: () => (
    <Modal defaultOpen>
      <ModalTrigger asChild>
        <Button variant="secondary">Open modal</Button>
      </ModalTrigger>
      <ModalContent>
        <ModalHeader>
          <ModalTitle>Initially open</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <Typography textColor="body">
            Rendered open so the layout is visible without interaction.
          </Typography>
        </ModalBody>
        <ModalFooter>
          <ModalClose asChild>
            <Button variant="secondary">Close</Button>
          </ModalClose>
        </ModalFooter>
      </ModalContent>
    </Modal>
  ),
};
