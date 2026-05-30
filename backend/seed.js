require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');

const User = require('./models/User');
const Department = require('./models/Department');
const Designation = require('./models/Designation');
const Template = require('./models/Template');
const Assignment = require('./models/Assignment');

/**
 * Seed script - creates demo users, departments, designations, templates
 * and assignments so the app is usable immediately after install.
 *
 *   node seed.js
 */
const run = async () => {
  await connectDB();

  console.log('[seed] Clearing existing data...');
  await Promise.all([
    User.deleteMany({}),
    Department.deleteMany({}),
    Designation.deleteMany({}),
    Template.deleteMany({}),
    Assignment.deleteMany({}),
  ]);

  console.log('[seed] Creating departments...');
  const [dAccts, dEng, dSales, dHR] = await Department.create([
    { name: 'Accounts', description: 'Finance and bookkeeping' },
    { name: 'Engineering', description: 'Product engineering' },
    { name: 'Sales', description: 'Field & inside sales' },
    { name: 'Human Resources', description: 'People operations' },
  ]);

  console.log('[seed] Creating designations...');
  const [desJunior, desSenior, desMgr, desHR] = await Designation.create([
    { title: 'Junior Associate' },
    { title: 'Senior Associate' },
    { title: 'Manager' },
    { title: 'HR Lead' },
  ]);

  console.log('[seed] Creating users...');
  const superAdmin = await User.create({
    name: 'Super Admin',
    employeeId: 'SA-001',
    email: 'superadmin@hrms.local',
    phone: '9000000000',
    password: 'password123',
    role: 'super_admin',
    department: dHR._id,
    designation: desHR._id,
    monthlySalary: 200000,
    weeklyOff: [0],
  });

  const hr = await User.create({
    name: 'HR Admin',
    employeeId: 'HR-001',
    email: 'hr@hrms.local',
    phone: '9000000001',
    password: 'password123',
    role: 'hr',
    department: dHR._id,
    designation: desHR._id,
    monthlySalary: 90000,
    weeklyOff: [0],
  });

  const e1 = await User.create({
    name: 'Aarav Sharma',
    employeeId: 'EMP-001',
    email: 'aarav@hrms.local',
    phone: '9000000002',
    password: 'password123',
    role: 'employee',
    department: dAccts._id,
    designation: desJunior._id,
    monthlySalary: 30000,
    weeklyOff: [0],
  });
  const e2 = await User.create({
    name: 'Priya Verma',
    employeeId: 'EMP-002',
    email: 'priya@hrms.local',
    phone: '9000000003',
    password: 'password123',
    role: 'employee',
    department: dEng._id,
    designation: desSenior._id,
    monthlySalary: 55000,
    weeklyOff: [0, 6],
  });
  const e3 = await User.create({
    name: 'Rohit Mehta',
    employeeId: 'EMP-003',
    email: 'rohit@hrms.local',
    phone: '9000000004',
    password: 'password123',
    role: 'employee',
    department: dSales._id,
    designation: desMgr._id,
    monthlySalary: 70000,
    weeklyOff: [0],
  });

  console.log('[seed] Creating templates...');
  const accountsTpl = await Template.create({
    title: 'Accounts Daily',
    description: 'Daily tasks for accounts team',
    createdBy: hr._id,
    tasks: [
      { title: 'Invoice Verification', points: 5 },
      { title: 'Bank Reconciliation', points: 10 },
      { title: 'Daily Stock Check', points: 8 },
    ],
  });

  const engTpl = await Template.create({
    title: 'Engineering Daily',
    createdBy: hr._id,
    tasks: [
      { title: 'PR Reviews', points: 6 },
      { title: 'Standup Update', points: 2 },
      { title: 'Tickets Closed', points: 10 },
    ],
  });

  const salesTpl = await Template.create({
    title: 'Sales Daily',
    createdBy: hr._id,
    tasks: [
      { title: 'Calls Made', points: 4 },
      { title: 'Demos Done', points: 8 },
      { title: 'CRM Updated', points: 3 },
    ],
  });

  // Excel reporting template (new template type) for the Sales team
  const telecallingTpl = await Template.create({
    title: 'Daily Telecalling Report',
    description: 'KPI reporting sheet for the telecalling / sales team',
    templateType: 'excel',
    createdBy: hr._id,
    excelColumns: [
      { fieldName: 'Calls Done', fieldType: 'number', markEligible: true, maxMarks: 10 },
      { fieldName: 'Leads Generated', fieldType: 'number', markEligible: true, maxMarks: 20 },
      { fieldName: 'Follow Ups', fieldType: 'number', markEligible: false, maxMarks: 0 },
      { fieldName: 'Call Outcome', fieldType: 'dropdown', markEligible: false, maxMarks: 0, options: ['Interested', 'Not Interested', 'Callback', 'Wrong Number'] },
      { fieldName: 'Remarks', fieldType: 'textarea', markEligible: false, maxMarks: 0 },
    ],
  });

  console.log('[seed] Creating assignments...');
  await Assignment.create([
    { template: accountsTpl._id, targetType: 'department', targetRef: dAccts._id, frequency: 'daily', createdBy: hr._id },
    { template: engTpl._id, targetType: 'department', targetRef: dEng._id, frequency: 'daily', createdBy: hr._id },
    { template: salesTpl._id, targetType: 'department', targetRef: dSales._id, frequency: 'daily', createdBy: hr._id },
    // Rohit (Sales) also gets the excel telecalling report
    { template: telecallingTpl._id, targetType: 'employee', targetRef: e3._id, frequency: 'daily', createdBy: hr._id },
  ]);

  console.log('\n[seed] Done!');
  console.log('  Super Admin : superadmin@hrms.local / password123');
  console.log('  HR login    : hr@hrms.local / password123');
  console.log('  Employee #1 : aarav@hrms.local / password123 (Accounts)');
  console.log('  Employee #2 : priya@hrms.local / password123 (Engineering)');
  console.log('  Employee #3 : rohit@hrms.local / password123 (Sales)');

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
