package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/aws/aws-sdk-go-v2/service/ec2instanceconnect"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"
)

const (
	tagDevBox      = "devbox"
	tagDevBoxName  = "devbox:name"
	tagDevBoxUser  = "devbox:user"
	tagDevBoxLabel = "devbox:label"
)

func main() {
	// Allow callers to override AWS_PROFILE without hardcoding an org-specific default.
	if v := os.Getenv("DEVBOX_AWS_PROFILE"); v != "" {
		os.Setenv("AWS_PROFILE", v)
	}

	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	var err error
	switch os.Args[1] {
	case "new":
		err = cmdNew(os.Args[2:])
	case "up":
		err = cmdUp(os.Args[2:])
	case "connect":
		err = cmdConnect(os.Args[2:])
	case "down":
		err = cmdDown(os.Args[2:])
	case "rm":
		err = cmdRm(os.Args[2:])
	case "list", "ls", "status":
		err = cmdList(os.Args[2:])
	case "help", "-h", "--help":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", os.Args[1])
		printUsage()
		os.Exit(1)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Fprintf(os.Stderr, `Usage: devbox <command> [flags]

Commands:
  new <label>  Launch a new dev box with the given label
  list         List all dev boxes (aliases: ls, status)
  up           Resume a stopped dev box
  down         Suspend (stop) a running dev box
  rm           Terminate (destroy) a dev box
  connect      Connect to a running dev box via SSM

Environment:
  DEVBOX_AWS_PROFILE  Optional AWS profile to use (overrides AWS_PROFILE)

Run 'devbox <command> -h' for command-specific flags.
`)
}

func username() string {
	u, err := user.Current()
	if err != nil {
		return "unknown"
	}
	return u.Username
}

func defaultRegion() string {
	if v := os.Getenv("AWS_REGION"); v != "" {
		return v
	}
	if v := os.Getenv("AWS_DEFAULT_REGION"); v != "" {
		return v
	}
	return "us-east-1"
}

func defaultAZ() string {
	return defaultRegion() + "a"
}

// opts holds flags common to all subcommands.
type opts struct {
	region  string
	name    string
	user    string
	sshKey  string
	sshUser string
	shpool  string
	label   string
}

func addCommonFlags(fs *flag.FlagSet) *opts {
	o := &opts{}
	fs.StringVar(&o.region, "region", defaultRegion(), "AWS region")
	fs.StringVar(&o.name, "name", "devbox", "dev box resource name prefix / launch template family")
	fs.StringVar(&o.user, "user", username(), "owner username for tagging")
	return o
}

func addConnectFlags(fs *flag.FlagSet, o *opts) {
	fs.StringVar(&o.sshKey, "ssh-key", "~/.ssh/id_ed25519.pub", "path to SSH public key")
	fs.StringVar(&o.sshUser, "ssh-user", "ec2-user", "OS user for SSH session")
	fs.StringVar(&o.shpool, "shpool", "", "attach to a shpool session (short: -s)")
	fs.StringVar(&o.shpool, "s", "", "shorthand for -shpool")
}

func addLabelFlag(fs *flag.FlagSet, o *opts) {
	fs.StringVar(&o.label, "label", "", "select box by label")
	fs.StringVar(&o.label, "l", "", "shorthand for -label")
}

// instanceInfo describes a dev box instance.
type instanceInfo struct {
	ID, Label, State, IP string
	Launched             time.Time
}

func newClients(ctx context.Context, region string) (*ec2.Client, *ssm.Client, *ec2instanceconnect.Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("loading AWS config: %w", err)
	}
	return ec2.NewFromConfig(cfg), ssm.NewFromConfig(cfg), ec2instanceconnect.NewFromConfig(cfg), nil
}

func devBoxFilters(name, user string, states ...string) []ec2types.Filter {
	filters := []ec2types.Filter{
		{Name: aws.String("tag:" + tagDevBox), Values: []string{"true"}},
		{Name: aws.String("tag:" + tagDevBoxName), Values: []string{name}},
		{Name: aws.String("tag:" + tagDevBoxUser), Values: []string{user}},
	}
	if len(states) > 0 {
		filters = append(filters, ec2types.Filter{
			Name: aws.String("instance-state-name"), Values: states,
		})
	}
	return filters
}

func findInstances(ctx context.Context, client *ec2.Client, name, user string, states ...string) ([]instanceInfo, error) {
	out, err := client.DescribeInstances(ctx, &ec2.DescribeInstancesInput{
		Filters: devBoxFilters(name, user, states...),
	})
	if err != nil {
		return nil, fmt.Errorf("describing instances: %w", err)
	}
	var instances []instanceInfo
	for _, res := range out.Reservations {
		for _, inst := range res.Instances {
			if inst.InstanceId == nil {
				continue
			}
			info := instanceInfo{
				ID:    *inst.InstanceId,
				State: string(inst.State.Name),
				IP:    aws.ToString(inst.PrivateIpAddress),
			}
			if inst.LaunchTime != nil {
				info.Launched = *inst.LaunchTime
			}
			for _, t := range inst.Tags {
				if aws.ToString(t.Key) == tagDevBoxLabel {
					info.Label = aws.ToString(t.Value)
				}
			}
			instances = append(instances, info)
		}
	}
	return instances, nil
}

func filterByLabel(instances []instanceInfo, label string) []instanceInfo {
	if label == "" {
		return instances
	}
	var filtered []instanceInfo
	for _, inst := range instances {
		if inst.Label == label {
			filtered = append(filtered, inst)
		}
	}
	return filtered
}

func instanceIDs(instances []instanceInfo) []string {
	ids := make([]string, len(instances))
	for i, inst := range instances {
		ids[i] = inst.ID
	}
	return ids
}

func displayLabel(inst instanceInfo) string {
	if inst.Label != "" {
		return inst.Label
	}
	return "(none)"
}

func pickInstance(instances []instanceInfo, prompt string) (instanceInfo, error) {
	if len(instances) == 0 {
		return instanceInfo{}, fmt.Errorf("no instances found")
	}
	if len(instances) == 1 {
		return instances[0], nil
	}
	fmt.Println(prompt)
	for i, inst := range instances {
		ip := inst.IP
		if ip == "" {
			ip = "-"
		}
		fmt.Printf("  [%d] %s\t%s\t%s\t%s\n", i+1, displayLabel(inst), inst.ID, inst.State, ip)
	}
	fmt.Print("Enter number: ")
	var choice int
	if _, err := fmt.Scan(&choice); err != nil {
		return instanceInfo{}, fmt.Errorf("reading selection: %w", err)
	}
	if choice < 1 || choice > len(instances) {
		return instanceInfo{}, fmt.Errorf("invalid selection: %d", choice)
	}
	return instances[choice-1], nil
}

func pickInstanceOrAll(instances []instanceInfo, prompt string) ([]instanceInfo, error) {
	if len(instances) == 0 {
		return nil, fmt.Errorf("no instances found")
	}
	if len(instances) == 1 {
		return instances, nil
	}
	fmt.Println(prompt)
	for i, inst := range instances {
		ip := inst.IP
		if ip == "" {
			ip = "-"
		}
		fmt.Printf("  [%d] %s\t%s\t%s\t%s\n", i+1, displayLabel(inst), inst.ID, inst.State, ip)
	}
	fmt.Printf("  [%d] all\n", len(instances)+1)
	fmt.Print("Enter number: ")
	var choice int
	if _, err := fmt.Scan(&choice); err != nil {
		return nil, fmt.Errorf("reading selection: %w", err)
	}
	if choice == len(instances)+1 {
		return instances, nil
	}
	if choice < 1 || choice > len(instances) {
		return nil, fmt.Errorf("invalid selection: %d", choice)
	}
	return []instanceInfo{instances[choice-1]}, nil
}

func findLaunchTemplate(ctx context.Context, client *ec2.Client, name, az string) (string, error) {
	prefix := name + "-" + az + "-"
	paginator := ec2.NewDescribeLaunchTemplatesPaginator(client, &ec2.DescribeLaunchTemplatesInput{})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return "", fmt.Errorf("describing launch templates: %w", err)
		}
		for _, lt := range page.LaunchTemplates {
			if lt.LaunchTemplateName != nil && strings.HasPrefix(*lt.LaunchTemplateName, prefix) {
				return *lt.LaunchTemplateId, nil
			}
		}
	}
	return "", fmt.Errorf("no launch template found with prefix %q (have you run terraform apply?)", prefix)
}

func expandPath(path string) (string, error) {
	if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolving home directory: %w", err)
		}
		path = filepath.Join(home, path[2:])
	}
	return path, nil
}

func startSSHSession(ctx context.Context, eicClient *ec2instanceconnect.Client, region, instanceID, sshKey, sshUser, shpool string) error {
	// Read the SSH public key
	keyPath, err := expandPath(sshKey)
	if err != nil {
		return err
	}
	keyBytes, err := os.ReadFile(keyPath)
	if err != nil {
		return fmt.Errorf("reading SSH public key %s: %w", keyPath, err)
	}
	keyMaterial := strings.TrimSpace(string(keyBytes))

	// Push the key via EC2 Instance Connect
	out, err := eicClient.SendSSHPublicKey(ctx, &ec2instanceconnect.SendSSHPublicKeyInput{
		InstanceId:     &instanceID,
		InstanceOSUser: &sshUser,
		SSHPublicKey:   &keyMaterial,
	})
	if err != nil {
		return fmt.Errorf("pushing SSH public key: %w", err)
	}
	if !out.Success {
		return fmt.Errorf("EC2 Instance Connect rejected the SSH public key")
	}

	// Exec into SSH with agent forwarding, using SSM as a proxy
	bin, err := exec.LookPath("ssh")
	if err != nil {
		return fmt.Errorf("finding ssh binary: %w", err)
	}
	proxyCmd := fmt.Sprintf(
		"aws ssm start-session --target %%h --document-name AWS-StartSSHSession --parameters portNumber=%%p --region %s",
		region,
	)
	argv := []string{"ssh", "-A",
		"-o", "StrictHostKeyChecking=no",
		"-o", "UserKnownHostsFile=/dev/null",
		"-o", "ProxyCommand=" + proxyCmd,
	}
	if shpool != "" {
		argv = append(argv, "-t", "-o", fmt.Sprintf("RemoteCommand=shpool attach -f %s", shpool))
	}
	argv = append(argv, fmt.Sprintf("%s@%s", sshUser, instanceID))
	return syscall.Exec(bin, argv, os.Environ())
}

func waitForSSM(ctx context.Context, client *ssm.Client, instanceID string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	fmt.Print("Waiting for SSM agent")
	for {
		out, err := client.DescribeInstanceInformation(ctx, &ssm.DescribeInstanceInformationInput{
			Filters: []ssmtypes.InstanceInformationStringFilter{
				{Key: aws.String("InstanceIds"), Values: []string{instanceID}},
			},
		})
		if err == nil && len(out.InstanceInformationList) > 0 &&
			out.InstanceInformationList[0].PingStatus == ssmtypes.PingStatusOnline {
			fmt.Println(" ready!")
			return nil
		}

		select {
		case <-ctx.Done():
			fmt.Println()
			return fmt.Errorf("timed out waiting for SSM agent on %s", instanceID)
		case <-time.After(5 * time.Second):
			fmt.Print(".")
		}
	}
}

func waitForCloudInit(ctx context.Context, client *ssm.Client, instanceID string) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()

	fmt.Print("Waiting for cloud-init to finish")

	// Send cloud-init status --wait via SSM Run Command
	docName := "AWS-RunShellScript"
	out, err := client.SendCommand(ctx, &ssm.SendCommandInput{
		InstanceIds:  []string{instanceID},
		DocumentName: &docName,
		Parameters:   map[string][]string{"commands": {"cloud-init status --wait"}},
	})
	if err != nil {
		return fmt.Errorf("sending cloud-init status command: %w", err)
	}
	commandID := *out.Command.CommandId

	for {
		inv, err := client.GetCommandInvocation(ctx, &ssm.GetCommandInvocationInput{
			CommandId:  &commandID,
			InstanceId: &instanceID,
		})
		if err == nil {
			switch inv.Status {
			case ssmtypes.CommandInvocationStatusSuccess:
				fmt.Println(" done!")
				return nil
			case ssmtypes.CommandInvocationStatusFailed,
				ssmtypes.CommandInvocationStatusTimedOut,
				ssmtypes.CommandInvocationStatusCancelled:
				fmt.Println()
				stderr := ""
				if inv.StandardErrorContent != nil {
					stderr = *inv.StandardErrorContent
				}
				return fmt.Errorf("cloud-init wait command failed (status %s): %s", inv.Status, stderr)
			}
		}

		select {
		case <-ctx.Done():
			fmt.Println()
			return fmt.Errorf("timed out waiting for cloud-init on %s", instanceID)
		case <-time.After(10 * time.Second):
			fmt.Print(".")
		}
	}
}

func cmdNew(args []string) error {
	fs := flag.NewFlagSet("new", flag.ExitOnError)
	o := addCommonFlags(fs)
	addConnectFlags(fs, o)
	az := fs.String("az", defaultAZ(), "availability zone")
	noConnect := fs.Bool("no-connect", false, "skip auto-connect after launch")
	fs.Parse(args)

	if fs.NArg() < 1 {
		return fmt.Errorf("usage: devbox new <label>")
	}
	label := fs.Arg(0)

	// Validate label: alphanumeric + hyphens only
	for _, c := range label {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-') {
			return fmt.Errorf("invalid label %q: only alphanumeric characters and hyphens are allowed", label)
		}
	}

	ctx := context.Background()
	ec2Client, ssmClient, eicClient, err := newClients(ctx, o.region)
	if err != nil {
		return err
	}

	// Check for duplicate label among non-terminated boxes
	existing, err := findInstances(ctx, ec2Client, o.name, o.user, "running", "pending", "stopping", "stopped")
	if err != nil {
		return err
	}
	for _, inst := range existing {
		if inst.Label == label {
			return fmt.Errorf("a dev box with label %q already exists (%s, %s)", label, inst.ID, inst.State)
		}
	}

	// Discover launch template
	ltID, err := findLaunchTemplate(ctx, ec2Client, o.name, *az)
	if err != nil {
		return err
	}

	instanceName := fmt.Sprintf("dev-box-%s-%s", o.user, label)
	fmt.Printf("Launching dev box %q from %s in %s...\n", instanceName, ltID, *az)

	latest := "$Latest"
	runOut, err := ec2Client.RunInstances(ctx, &ec2.RunInstancesInput{
		LaunchTemplate: &ec2types.LaunchTemplateSpecification{
			LaunchTemplateId: &ltID,
			Version:          &latest,
		},
		MinCount: aws.Int32(1),
		MaxCount: aws.Int32(1),
		TagSpecifications: []ec2types.TagSpecification{{
			ResourceType: ec2types.ResourceTypeInstance,
			Tags: []ec2types.Tag{
				{Key: aws.String("Name"), Value: aws.String(instanceName)},
				{Key: aws.String(tagDevBox), Value: aws.String("true")},
				{Key: aws.String(tagDevBoxName), Value: aws.String(o.name)},
				{Key: aws.String(tagDevBoxUser), Value: aws.String(o.user)},
				{Key: aws.String(tagDevBoxLabel), Value: aws.String(label)},
			},
		}},
	})
	if err != nil {
		return fmt.Errorf("launching instance: %w", err)
	}

	instanceID := *runOut.Instances[0].InstanceId
	fmt.Printf("Instance %s launched\n", instanceID)

	// Wait for running
	fmt.Print("Waiting for instance to start")
	waiter := ec2.NewInstanceRunningWaiter(ec2Client)
	if err := waiter.Wait(ctx, &ec2.DescribeInstancesInput{
		InstanceIds: []string{instanceID},
	}, 5*time.Minute); err != nil {
		return fmt.Errorf("waiting for instance: %w", err)
	}
	fmt.Println(" running!")

	// Wait for SSM
	if err := waitForSSM(ctx, ssmClient, instanceID); err != nil {
		return err
	}

	// Wait for cloud-init
	if err := waitForCloudInit(ctx, ssmClient, instanceID); err != nil {
		return err
	}

	if *noConnect {
		fmt.Printf("Dev box %q ready! Connect with: devbox connect -label %s\n", label, label)
		return nil
	}

	fmt.Printf("Connecting to %s...\n", instanceID)
	return startSSHSession(ctx, eicClient, o.region, instanceID, o.sshKey, o.sshUser, o.shpool)
}

func cmdUp(args []string) error {
	fs := flag.NewFlagSet("up", flag.ExitOnError)
	o := addCommonFlags(fs)
	addLabelFlag(fs, o)
	fs.Parse(args)

	ctx := context.Background()
	ec2Client, ssmClient, _, err := newClients(ctx, o.region)
	if err != nil {
		return err
	}

	instances, err := findInstances(ctx, ec2Client, o.name, o.user, "stopped", "stopping")
	if err != nil {
		return err
	}
	instances = filterByLabel(instances, o.label)

	if len(instances) == 0 {
		return fmt.Errorf("no stopped dev boxes found (use 'devbox new <label>' to launch a new one)")
	}

	inst, err := pickInstance(instances, "Multiple stopped boxes found. Which one to resume?")
	if err != nil {
		return err
	}

	fmt.Printf("Resuming dev box: %s", inst.ID)
	if inst.Label != "" {
		fmt.Printf(" (%s)", inst.Label)
	}
	fmt.Println()

	_, err = ec2Client.StartInstances(ctx, &ec2.StartInstancesInput{
		InstanceIds: []string{inst.ID},
	})
	if err != nil {
		return fmt.Errorf("starting instance: %w", err)
	}

	fmt.Print("Waiting for instance to start")
	waiter := ec2.NewInstanceRunningWaiter(ec2Client)
	if err := waiter.Wait(ctx, &ec2.DescribeInstancesInput{
		InstanceIds: []string{inst.ID},
	}, 5*time.Minute); err != nil {
		return fmt.Errorf("waiting for instance: %w", err)
	}
	fmt.Println(" running!")

	if err := waitForSSM(ctx, ssmClient, inst.ID); err != nil {
		return err
	}

	if inst.Label != "" {
		fmt.Printf("Dev box %q ready! Connect with: devbox connect -label %s\n", inst.Label, inst.Label)
	} else {
		fmt.Printf("Dev box %s ready! Connect with: devbox connect\n", inst.ID)
	}
	return nil
}

func cmdDown(args []string) error {
	fs := flag.NewFlagSet("down", flag.ExitOnError)
	o := addCommonFlags(fs)
	addLabelFlag(fs, o)
	all := fs.Bool("all", false, "stop all running dev boxes")
	fs.Parse(args)

	ctx := context.Background()
	ec2Client, _, _, err := newClients(ctx, o.region)
	if err != nil {
		return err
	}

	instances, err := findInstances(ctx, ec2Client, o.name, o.user, "running", "pending")
	if err != nil {
		return err
	}
	instances = filterByLabel(instances, o.label)

	if len(instances) == 0 {
		fmt.Println("No running dev box instances found.")
		return nil
	}

	var targets []instanceInfo
	if *all || o.label != "" {
		targets = instances
	} else {
		targets, err = pickInstanceOrAll(instances, "Multiple running boxes found. Which one to stop?")
		if err != nil {
			return err
		}
	}

	ids := instanceIDs(targets)
	fmt.Printf("Suspending %s...\n", strings.Join(ids, ", "))
	_, err = ec2Client.StopInstances(ctx, &ec2.StopInstancesInput{
		InstanceIds: ids,
	})
	if err != nil {
		return fmt.Errorf("stopping instances: %w", err)
	}
	fmt.Println("Done. Instance(s) suspended (use 'devbox up' to resume, 'devbox rm' to terminate).")
	return nil
}

func cmdRm(args []string) error {
	fs := flag.NewFlagSet("rm", flag.ExitOnError)
	o := addCommonFlags(fs)
	addLabelFlag(fs, o)
	all := fs.Bool("all", false, "terminate all dev boxes")
	fs.Parse(args)

	ctx := context.Background()
	ec2Client, _, _, err := newClients(ctx, o.region)
	if err != nil {
		return err
	}

	instances, err := findInstances(ctx, ec2Client, o.name, o.user, "running", "pending", "stopping", "stopped")
	if err != nil {
		return err
	}
	instances = filterByLabel(instances, o.label)

	if len(instances) == 0 {
		fmt.Println("No dev box instances found.")
		return nil
	}

	var targets []instanceInfo
	if *all || o.label != "" {
		targets = instances
	} else {
		targets, err = pickInstanceOrAll(instances, "Multiple boxes found. Which one to terminate?")
		if err != nil {
			return err
		}
	}

	ids := instanceIDs(targets)
	fmt.Printf("Terminating %s...\n", strings.Join(ids, ", "))
	_, err = ec2Client.TerminateInstances(ctx, &ec2.TerminateInstancesInput{
		InstanceIds: ids,
	})
	if err != nil {
		return fmt.Errorf("terminating instances: %w", err)
	}
	fmt.Println("Done.")
	return nil
}

func cmdConnect(args []string) error {
	fs := flag.NewFlagSet("connect", flag.ExitOnError)
	o := addCommonFlags(fs)
	addConnectFlags(fs, o)
	addLabelFlag(fs, o)
	fs.Parse(args)

	ctx := context.Background()
	ec2Client, _, eicClient, err := newClients(ctx, o.region)
	if err != nil {
		return err
	}

	instances, err := findInstances(ctx, ec2Client, o.name, o.user, "running", "pending")
	if err != nil {
		return err
	}
	instances = filterByLabel(instances, o.label)

	if len(instances) == 0 {
		return fmt.Errorf("no running dev box found for user %q (run 'devbox new <label>' to launch one)", o.user)
	}

	inst, err := pickInstance(instances, "Multiple running boxes found. Which one to connect to?")
	if err != nil {
		return err
	}

	return startSSHSession(ctx, eicClient, o.region, inst.ID, o.sshKey, o.sshUser, o.shpool)
}

func cmdList(args []string) error {
	fs := flag.NewFlagSet("list", flag.ExitOnError)
	o := addCommonFlags(fs)
	fs.Parse(args)

	ctx := context.Background()
	ec2Client, _, _, err := newClients(ctx, o.region)
	if err != nil {
		return err
	}

	instances, err := findInstances(ctx, ec2Client, o.name, o.user, "running", "pending", "stopping", "stopped")
	if err != nil {
		return err
	}

	if len(instances) == 0 {
		fmt.Println("No dev box instances found.")
		return nil
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "LABEL\tINSTANCE ID\tSTATE\tPRIVATE IP\tLAUNCHED")
	for _, inst := range instances {
		ip := inst.IP
		if ip == "" {
			ip = "-"
		}
		launched := "-"
		if !inst.Launched.IsZero() {
			launched = inst.Launched.Format(time.RFC3339)
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", displayLabel(inst), inst.ID, inst.State, ip, launched)
	}
	w.Flush()
	return nil
}
