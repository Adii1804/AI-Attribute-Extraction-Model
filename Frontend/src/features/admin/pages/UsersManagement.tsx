import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Form,
  Input,
  Select,
  Modal,
  Popconfirm,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { PlusOutlined, UserOutlined } from '@ant-design/icons';
import { createUser, deactivateUser, getUsers, type AdminUser } from '../../../services/adminApi';

const { Title, Text } = Typography;

export default function UsersManagement() {
  const queryClient = useQueryClient();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form] = Form.useForm();

  const user = localStorage.getItem('user');
  const userData = user ? JSON.parse(user) : null;

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: getUsers,
  });

  const createUserMutation = useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      message.success('User created successfully');
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setIsModalOpen(false);
      form.resetFields();
    },
    onError: (error: any) => {
      message.error(error?.response?.data?.error || 'Failed to create user');
    },
  });

  const deactivateUserMutation = useMutation({
    mutationFn: deactivateUser,
    onSuccess: () => {
      message.success('User deactivated');
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (error: any) => {
      message.error(error?.response?.data?.error || 'Failed to deactivate user');
    },
  });

  const handleCreateUser = async () => {
    try {
      const values = await form.validateFields();
      createUserMutation.mutate({
        email: values.email,
        password: values.password,
        name: values.name,
        role: values.role,
      });
    } catch (error) {
      console.error('Validation failed', error);
    }
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (value: string) => <Text strong>{value}</Text>,
    },
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
    },
    {
      title: 'Role',
      dataIndex: 'role',
      key: 'role',
      render: (role: AdminUser['role']) => (
        <Tag color={role === 'ADMIN' ? 'geekblue' : 'default'}>{role}</Tag>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'isActive',
      key: 'isActive',
      render: (active: boolean) => (
        <Tag color={active ? 'green' : 'red'}>{active ? 'ACTIVE' : 'INACTIVE'}</Tag>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (value: string) => new Date(value).toLocaleString(),
    },
    {
      title: 'Last Login',
      dataIndex: 'lastLogin',
      key: 'lastLogin',
      render: (value: string | null) => (value ? new Date(value).toLocaleString() : '—'),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: any, record: AdminUser) => {
        const isSelf = userData?.id === record.id;
        return (
          <Popconfirm
            title="Deactivate user"
            description="This will prevent the user from logging in. Continue?"
            onConfirm={() => deactivateUserMutation.mutate(record.id)}
            okButtonProps={{ danger: true }}
            disabled={!record.isActive || isSelf}
          >
            <Button danger size="small" disabled={!record.isActive || isSelf}>
              Deactivate
            </Button>
          </Popconfirm>
        );
      },
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <Title level={3} style={{ marginBottom: 4 }}>User Management</Title>
            <Text type="secondary">Add users and manage access roles.</Text>
          </div>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setIsModalOpen(true)}>
            Add User
          </Button>
        </div>
      </Card>

      <Card style={{ marginTop: 16 }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={users.filter((u) => u.isActive)}
          loading={isLoading}
          pagination={{ pageSize: 10 }}
          locale={{ emptyText: 'No users found' }}
        />
      </Card>

      <Modal
        title="Create User"
        open={isModalOpen}
        onOk={handleCreateUser}
        onCancel={() => setIsModalOpen(false)}
        confirmLoading={createUserMutation.isPending}
      >
        <Form form={form} layout="vertical" initialValues={{ role: 'USER' }}>
          <Form.Item
            name="name"
            label="Name"
            rules={[{ required: true, message: 'Please enter name' }]}
          >
            <Input placeholder="Full name" prefix={<UserOutlined />} />
          </Form.Item>
          <Form.Item
            name="email"
            label="Email"
            rules={[
              { required: true, message: 'Please enter email' },
              { type: 'email', message: 'Enter a valid email' },
            ]}
          >
            <Input placeholder="name@company.com" />
          </Form.Item>
          <Form.Item
            name="password"
            label="Password"
            rules={[
              { required: true, message: 'Please enter password' },
              { min: 6, message: 'Minimum 6 characters' },
            ]}
          >
            <Input.Password placeholder="Temporary password" />
          </Form.Item>
          <Form.Item
            name="role"
            label="Role"
            rules={[{ required: true }]}
          >
            <Select
              options={[
                { value: 'ADMIN', label: 'ADMIN' },
                { value: 'USER', label: 'USER' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
