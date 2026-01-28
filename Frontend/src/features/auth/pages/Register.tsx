import { useState } from 'react';
import { Form, Input, Button, Card, Typography, message } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { BackendApiService } from '../../../services/api/backendApi';

const { Title, Text } = Typography;
const api = new BackendApiService();

export default function Register() {
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const onFinish = async (values: { email: string; password: string; confirmPassword: string }) => {
    if (values.password !== values.confirmPassword) {
      message.error('Passwords do not match!');
      return;
    }

    setLoading(true);
    try {
      const result = await api.register(values.email, values.password);
      localStorage.setItem('authToken', result.token);
      localStorage.setItem('user', JSON.stringify(result.user));
      message.success('Registration successful!');
      navigate('/dashboard');
    } catch (error) {
      message.error('Registration failed. Please try again.');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ 
      minHeight: '100vh', 
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #FF6F61 0%, #FFA62B 100%)'
    }}>
      <Card style={{ width: 400, boxShadow: '0 8px 32px rgba(0,0,0,0.1)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Title level={2} style={{ color: '#FF6F61' }}>Join Us</Title>
          <Text type="secondary">Create your AI Fashion Extractor account</Text>
        </div>
        
        <Form onFinish={onFinish} size="large">
          <Form.Item 
            name="email" 
            rules={[
              { required: true, message: 'Please input your email!' },
              { type: 'email', message: 'Please enter a valid email!' }
            ]}
          >
            <Input prefix={<UserOutlined />} placeholder="Email" />
          </Form.Item>
          
          <Form.Item 
            name="password" 
            rules={[
              { required: true, message: 'Please input your password!' },
              { min: 6, message: 'Password must be at least 6 characters!' }
            ]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="Password" />
          </Form.Item>
          
          <Form.Item 
            name="confirmPassword" 
            rules={[{ required: true, message: 'Please confirm your password!' }]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="Confirm Password" />
          </Form.Item>
          
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block>
              Sign Up
            </Button>
          </Form.Item>
        </Form>
        
        <div style={{ textAlign: 'center' }}>
          <Text>Already have an account? <Link to="/login">Sign in</Link></Text>
        </div>
      </Card>
    </div>
  );
}