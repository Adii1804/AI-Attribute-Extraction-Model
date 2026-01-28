import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Input, Space, Table, Tag, Typography, Empty, message, Modal, Image, Descriptions } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { APP_CONFIG } from '../../../constants/app/config';
import type { SchemaItem } from '../../../shared/types/extraction/ExtractionTypes';
import {
  ORDERED_EXPORT_HEADERS,
  HEADER_TO_SCHEMA_KEY,
  buildExportSchema,
  exportToExcel,
  mapMasterAttributes
} from '../../../shared/utils/export/extractionExport';
import './Products.css';

const { Title, Text } = Typography;

type ProductRow = {
  key: string;
  name: string;
  productType: string;
  vendor: string;
  status: 'COMPLETED' | 'FAILED' | 'PROCESSING' | 'PENDING';
  rawStatus?: string | null;
  createdAt: string;
  updatedAt: string;
  userName?: string | null;
  userEmail?: string | null;
  imageUrl?: string | null;
  results?: Array<{
    attribute?: { key?: string | null; label?: string | null } | null;
    rawValue?: string | number | null;
    finalValue?: string | number | null;
    confidence?: number | null;
  }>;
};

export default function Products() {
  const user = localStorage.getItem('user');
  const userData = user ? JSON.parse(user) : null;
  const isAdmin = userData?.role === 'ADMIN';

  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedImage, setSelectedImage] = useState<{ url: string; name: string } | null>(null);
  const [detailsRow, setDetailsRow] = useState<ProductRow | null>(null);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [selectedRows, setSelectedRows] = useState<ProductRow[]>([]);
  const [masterAttributes, setMasterAttributes] = useState<SchemaItem[]>([]);

  const normalizeStatus = useCallback((status?: string | null): ProductRow['status'] => {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'done' || normalized === 'completed' || normalized === 'complete') return 'COMPLETED';
    if (normalized === 'error' || normalized === 'failed' || normalized === 'fail') return 'FAILED';
    if (normalized === 'processing' || normalized === 'extracting') return 'PROCESSING';
    return 'PENDING';
  }, []);

  const getMajorCategory = useCallback((results?: ProductRow['results']) => {
    if (!results || results.length === 0) return null;
    const match = results.find(item => {
      const key = item.attribute?.key?.toLowerCase();
      const label = item.attribute?.label?.toLowerCase();
      return key === 'major_category' || key === 'majorcategory' || label === 'major category' || label?.includes('major category');
    });
    const value = match?.finalValue ?? match?.rawValue ?? null;
    return value ? String(value) : null;
  }, []);

  const exportSchema = useMemo(() => buildExportSchema(masterAttributes, masterAttributes), [masterAttributes]);

  const buildDetailsRows = useCallback((row: ProductRow) => {
    const results = row.results || [];
    return results
      .filter((item) => {
        const raw = item.rawValue;
        const final = item.finalValue;
        const hasRaw = typeof raw === 'string' ? raw.trim() !== '' : raw !== null && raw !== undefined;
        const hasFinal = typeof final === 'string' ? final.trim() !== '' : final !== null && final !== undefined;
        return hasRaw || hasFinal;
      })
      .map((item) => ({
        attribute: item.attribute,
        rawValue: item.rawValue ?? '—',
        finalValue: item.finalValue ?? '—',
        confidence: item.confidence
      }));
  }, []);

  const buildDetailsRowsWithMajor = useCallback((row: ProductRow) => {
    const rows = buildDetailsRows(row);
    const majorValue = getMajorCategory(row.results);
    const hasMajor = rows.some((item) => {
      const key = item.attribute?.key?.toLowerCase();
      const label = item.attribute?.label?.toLowerCase();
      return key === 'major_category' || key === 'majorcategory' || label === 'major category' || label?.includes('major category');
    });

    if (hasMajor) return rows;

    return [
      {
        attribute: { key: 'major_category', label: 'Major Category' },
        rawValue: majorValue || '—',
        finalValue: majorValue || '—',
        confidence: null
      },
      ...rows
    ];
  }, [buildDetailsRows, getMajorCategory]);

  const buildOrderedExportDataFromResults = useCallback((items: ProductRow[]) => {
    return items.map((row) => {
      const byKey = new Map<string, ProductRow['results'][number]>();
      const byLabel = new Map<string, ProductRow['results'][number]>();

      (row.results || []).forEach((item) => {
        const key = item.attribute?.key?.toLowerCase();
        const label = item.attribute?.label?.toLowerCase();
        if (key) byKey.set(key, item);
        if (label) byLabel.set(label, item);
      });

      const record: Record<string, string | number | undefined> = {};
      ORDERED_EXPORT_HEADERS.forEach((header) => {
        if (header === 'CREATION DATE') {
          record[header] = row.createdAt || '';
          return;
        }

        const schemaKey = HEADER_TO_SCHEMA_KEY[header];
        const match = schemaKey
          ? byKey.get(schemaKey.toLowerCase())
          : byLabel.get(header.toLowerCase());

        const value = match?.finalValue ?? match?.rawValue ?? '';
        record[header] = value ?? '';
      });

      return record;
    });
  }, []);

  const handleView = useCallback((row: ProductRow) => {
    if (!row.imageUrl) {
      message.warning('No image available for this extraction');
      return;
    }
    setSelectedImage({ url: row.imageUrl, name: row.name });
  }, []);

  const handleViewDetails = useCallback((row: ProductRow) => {
    setDetailsRow(row);
  }, []);

  const handleExport = useCallback(async (row: ProductRow) => {
    if (!row.results || row.results.length === 0 || row.status !== 'COMPLETED') {
      message.warning('No completed extraction to export');
      return;
    }
    const exportData = buildOrderedExportDataFromResults([row]);
    await exportToExcel(exportData, ORDERED_EXPORT_HEADERS, exportSchema, row.productType || 'results');
  }, [buildOrderedExportDataFromResults, exportSchema]);

  const handleBulkExport = useCallback(async () => {
    if (selectedRows.length === 0) {
      message.warning('Select at least one product to export');
      return;
    }

    const completedRows = selectedRows.filter(
      row => row.status === 'COMPLETED' && row.results && row.results.length > 0
    );

    if (completedRows.length === 0) {
      message.warning('No completed extractions in the selection');
      return;
    }

    if (completedRows.length !== selectedRows.length) {
      message.info('Some selected items are not completed and will be skipped');
    }

    const exportData = buildOrderedExportDataFromResults(completedRows);
    await exportToExcel(exportData, ORDERED_EXPORT_HEADERS, exportSchema, 'bulk');
  }, [buildOrderedExportDataFromResults, exportSchema, selectedRows]);

  const columns = useMemo(() => {
    const baseColumns = [
      {
        title: 'Image',
        key: 'image',
        render: (_: unknown, row: ProductRow) => (
          <div style={{ width: 64, height: 64, borderRadius: 12, overflow: 'hidden', background: '#f5f5f5' }}>
            {row.imageUrl ? (
              <img
                src={row.imageUrl}
                alt={row.name}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : null}
          </div>
        )
      },
      {
        title: 'Extracted Data',
        key: 'extractedData',
        render: (_: unknown, row: ProductRow) => {
          const items = (row.results || [])
            .filter(item => {
              const raw = item.rawValue;
              const final = item.finalValue;
              const hasRaw = typeof raw === 'string' ? raw.trim() !== '' : raw !== null && raw !== undefined;
              const hasFinal = typeof final === 'string' ? final.trim() !== '' : final !== null && final !== undefined;
              return hasRaw || hasFinal;
            })
            .slice(0, 6)
            .map(item => `${item.attribute?.label || item.attribute?.key}: ${item.finalValue ?? item.rawValue ?? '—'}`);
          return (
            <div style={{ maxWidth: 420 }}>
              {items.length > 0 ? (
                <Text type="secondary" style={{ fontSize: 12 }}>{items.join(', ')}</Text>
              ) : (
                <Text type="secondary">—</Text>
              )}
            </div>
          );
        }
      },
      ...(isAdmin ? [
        {
          title: 'User',
          key: 'user',
          render: (_: unknown, row: ProductRow) => (
            <div>
              <div>{row.userName || '—'}</div>
              <Text type="secondary" style={{ fontSize: 12 }}>{row.userEmail || ''}</Text>
            </div>
          )
        }
      ] : []),
      {
        title: 'Created At',
        dataIndex: 'createdAt',
        key: 'createdAt'
      },
      {
        title: 'Status',
        dataIndex: 'status',
        key: 'status',
        render: (status: ProductRow['status']) => {
          const color = status === 'COMPLETED'
            ? 'green'
            : status === 'FAILED'
              ? 'red'
              : status === 'PROCESSING'
                ? 'blue'
                : 'gold';
          return <Tag color={color} className="products-status-tag">{status}</Tag>;
        }
      },
      {
        title: 'Actions',
        key: 'actions',
        render: (_: unknown, row: ProductRow) => (
          <Space>
            <Button size="small" onClick={() => handleView(row)} disabled={!row.imageUrl}>
              View Image
            </Button>
            <Button size="small" onClick={() => handleViewDetails(row)}>
              Details
            </Button>
            <Button size="small" onClick={() => handleExport(row)} disabled={!row.results?.length || row.status !== 'COMPLETED'}>
              Download
            </Button>
          </Space>
        )
      }
    ];
    return baseColumns;
  }, [handleExport, handleView, handleViewDetails, isAdmin]);

  useEffect(() => {
    const fetchRows = async () => {
      setLoading(true);
      try {
        const token = localStorage.getItem('authToken');
        const base = APP_CONFIG.api.baseURL;
        const endpoint = isAdmin ? `${base}/admin/extractions` : `${base}/user/history`;
        const response = await fetch(endpoint, {
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          }
        });

        if (!response.ok) {
          throw new Error('Failed to fetch extraction history');
        }

        const result = await response.json();
        const jobs = result?.data?.jobs || [];

        const mapped: ProductRow[] = jobs.map((job: any) => {
          const results = job.results || [];
          const majorCategory = getMajorCategory(results);
          const rawStatus = job.status;
          return {
            key: job.id,
            name: job.designNumber || job.category?.name || job.id,
            productType: majorCategory || job.category?.name || '—',
            vendor: job.vendorName || '—',
            status: normalizeStatus(job.status),
            rawStatus,
            createdAt: job.createdAt ? new Date(job.createdAt).toLocaleString() : '—',
            updatedAt: job.updatedAt ? new Date(job.updatedAt).toLocaleString() : '—',
            userName: job.user?.name,
            userEmail: job.user?.email,
            imageUrl: job.imageUrl || null,
            results
          };
        });
        setRows(mapped);
        localStorage.setItem('extractionsLastUpdated', `${Date.now()}`);
      } catch (error) {
        message.error('Unable to load extraction history');
      } finally {
        setLoading(false);
      }
    };

    fetchRows();
  }, [getMajorCategory, isAdmin, normalizeStatus]);

  useEffect(() => {
    const fetchMasterAttributes = async () => {
      try {
        const token = localStorage.getItem('authToken');
        const response = await fetch(`${APP_CONFIG.api.baseURL}/user/attributes?includeValues=true`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined
        });

        if (!response.ok) return;

        const result = await response.json().catch(() => null);
        const data = result?.data;
        if (!Array.isArray(data)) return;

        setMasterAttributes(mapMasterAttributes(data));
      } catch {
        // ignore
      }
    };

    fetchMasterAttributes();
  }, []);

  const filteredRows = rows.filter(row => {
    const haystack = `${row.name} ${row.productType} ${row.vendor} ${row.userName || ''} ${row.userEmail || ''}`
      .toLowerCase();
    return haystack.includes(search.toLowerCase());
  });

  return (
    <div className="products-page">
      <div className="products-hero">
        <div>
          <Title level={2} className="products-title">History</Title>
          <Text type="secondary">
            Your extraction history with direct extracted data and export options.
          </Text>
        </div>
        <Space size="middle">
          <Button
            onClick={handleBulkExport}
            disabled={selectedRows.length === 0}
          >
            Bulk Download
          </Button>
          <Input
            prefix={<SearchOutlined />}
            placeholder="Search history"
            className="products-search"
            allowClear
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </Space>
      </div>

      <Card className="products-table-card">
        {filteredRows.length === 0 ? (
          <Empty description="No extraction history yet" />
        ) : (
          <Table
            columns={columns}
            dataSource={filteredRows}
            pagination={{ pageSize: 8 }}
            className="products-table"
            loading={loading}
            rowSelection={{
              selectedRowKeys,
              onChange: (keys, selected) => {
                setSelectedRowKeys(keys as string[]);
                setSelectedRows(selected as ProductRow[]);
              }
            }}
          />
        )}
      </Card>

      <Modal
        title={selectedImage?.name || 'Uploaded Image'}
        open={!!selectedImage}
        onCancel={() => setSelectedImage(null)}
        footer={null}
        width={720}
      >
        {selectedImage?.url ? (
          <Image src={selectedImage.url} alt={selectedImage.name} style={{ width: '100%' }} />
        ) : (
          <Empty description="No image available" />
        )}
      </Modal>

      <Modal
        title={detailsRow?.name || 'Extraction Details'}
        open={!!detailsRow}
        onCancel={() => setDetailsRow(null)}
        footer={null}
        width={900}
      >
        {detailsRow ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="Major Category">{detailsRow.productType || '—'}</Descriptions.Item>
              <Descriptions.Item label="Status">{detailsRow.status}</Descriptions.Item>
              <Descriptions.Item label="Vendor">{detailsRow.vendor || '—'}</Descriptions.Item>
              <Descriptions.Item label="Updated At">{detailsRow.updatedAt || '—'}</Descriptions.Item>
              <Descriptions.Item label="Created At">{detailsRow.createdAt || '—'}</Descriptions.Item>
              {detailsRow.userName ? (
                <Descriptions.Item label="User">{detailsRow.userName} ({detailsRow.userEmail || '—'})</Descriptions.Item>
              ) : null}
            </Descriptions>

            <div>
              <Text strong>Extraction Result</Text>
              <Table
                size="small"
                rowKey={(row) => `${row.attribute?.key || row.attribute?.label}-${row.rawValue}-${row.finalValue}`}
                dataSource={buildDetailsRowsWithMajor(detailsRow)}
                columns={[
                  {
                    title: 'Attribute',
                    dataIndex: 'attribute',
                    key: 'attribute',
                    render: (attr: ProductRow['results'][number]['attribute']) => attr?.label || attr?.key || '—'
                  },
                  {
                    title: 'Raw Value',
                    dataIndex: 'rawValue',
                    key: 'rawValue',
                    render: (value: string | null) => value || '—'
                  },
                  {
                    title: 'Final Value',
                    dataIndex: 'finalValue',
                    key: 'finalValue',
                    render: (value: string | null) => value || '—'
                  },
                  {
                    title: 'Confidence',
                    dataIndex: 'confidence',
                    key: 'confidence',
                    render: (confidence: number | null | undefined) =>
                      typeof confidence === 'number' ? `${confidence}%` : '—'
                  }
                ]}
                pagination={{ pageSize: 12 }}
                locale={{ emptyText: 'No extraction data available' }}
              />
            </div>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
