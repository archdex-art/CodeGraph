import java.util.Scanner;

public class Solution {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int t = sc.nextInt();
        while (t-- > 0) {
            int n = sc.nextInt();

            int min = Integer.MAX_VALUE;
            int max = Integer.MIN_VALUE;

            for (int i = 0; i < n; i++) {
                int x = sc.nextInt();
                if (i % 2 == 1) {
                    min = x;
                } else {
                    if (max < x) {
                        max = x;
                    }
                }
            }

            if (n % 2 == 1) {
                System.out.println("NO");
            } else {
                if (min - max >= 2)
                    System.out.println("YES");
                else
                    System.out.println("NO");
            }

        }
    }
}